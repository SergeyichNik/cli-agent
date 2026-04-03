import type { LLMProvider, Message } from '../providers/base.js';
import type { WorkingMemory } from '../memory/wm.js';
import type { LongTermMemory } from '../memory/ltm.js';
import type { SessionMemory } from '../memory/sm.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { UserConfig } from '../user/profile.js';
import type { StreamRenderer } from '../ui/stream.js';
import { TaskStateMachine, parseMetadataLine, stripMetadataLine } from './task-state.js';
import { checkToolInvariants, InvariantViolationError } from './invariants.js';
import { buildSystemPrompt, buildContext } from '../context/optimizer.js';
import { summarizeIfNeeded } from '../context/summarizer.js';
import { extractAndSaveFactsAsync } from '../context/sticky.js';
import readline from 'readline';

export interface AgentDeps {
  provider: LLMProvider;
  wm: WorkingMemory;
  ltm: LongTermMemory;
  sm: SessionMemory;
  tools: ToolRegistry;
  config: UserConfig;
  renderer: StreamRenderer;
  sessionId: string;
  debug?: boolean;
  confirmFn: (prompt: string) => Promise<boolean>;
}

export async function runAgentTurn(userMessage: string, deps: AgentDeps): Promise<void> {
  const { provider, wm, ltm, sm, tools, config, renderer, sessionId } = deps;
  const stateMachine = new TaskStateMachine();
  stateMachine.state = sm.taskState;

  const systemPrompt = buildSystemPrompt(config, ltm, sessionId);
  const messages = buildContext(userMessage, systemPrompt, wm, ltm);

  // Add user message to WM
  wm.add({ role: 'user', content: userMessage });

  renderer.startSpinner();

  let fullResponseText = '';
  let depth = 0;
  const maxDepth = config.maxToolDepth;
  const maxRetries = config.maxToolRetries;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  // Agentic loop: continue until done or depth exceeded
  while (depth < maxDepth) {
    let text = '';
    const pendingToolCalls: Array<{ id: string; name: string; arguments: string }> = [];

    for await (const chunk of provider.stream(messages, {
      tools: tools.listForLLM(),
      temperature: 0.7,
    })) {
      if (chunk.type === 'text') {
        renderer.onToken(chunk.text);
        text += chunk.text;
      } else if (chunk.type === 'tool_call') {
        pendingToolCalls.push({ id: chunk.id, name: chunk.name, arguments: chunk.arguments });
      } else if (chunk.type === 'usage') {
        totalInputTokens += chunk.input_tokens;
        totalOutputTokens += chunk.output_tokens;
      } else if (chunk.type === 'done') {
        if (chunk.finish_reason === 'stop') {
          break;
        }
      }
    }

    if (text) {
      fullResponseText += text;
    }

    // If no tool calls, we're done
    if (pendingToolCalls.length === 0) break;

    // Flush any buffered text before showing tool calls
    renderer.finalize();

    const toolResultMessages: Message[] = [];

    // Add assistant message with tool_calls to context
    messages.push({
      role: 'assistant',
      content: text || null,
      tool_calls: pendingToolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.arguments },
      })),
    });

    for (const tc of pendingToolCalls) {
      renderer.showToolCall(tc.name, tc.arguments);

      let params: Record<string, unknown> = {};
      try {
        params = JSON.parse(tc.arguments) as Record<string, unknown>;
      } catch {
        params = {};
      }

      // Invariant check
      try {
        checkToolInvariants(tc.name, params, tools.sandboxDir);
      } catch (err) {
        if (err instanceof InvariantViolationError) {
          renderer.showError(`Invariant violation: ${err.message}`);
          sm.consecutiveToolErrors++;
          toolResultMessages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: `Error: ${err.message}`,
          });
          continue;
        }
        throw err;
      }

      // Confirmation for destructive tools
      if (tools.isDestructive(tc.name)) {
        const confirmed = await deps.confirmFn(
          `Allow ${tc.name}(${tc.arguments.slice(0, 80)}${tc.arguments.length > 80 ? '...' : ''})? [y/N] `,
        );
        if (!confirmed) {
          renderer.showInfo('Tool call skipped by user.');
          toolResultMessages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: 'User declined to execute this tool call.',
          });
          continue;
        }
      }

      // Execute tool
      const tool = tools.get(tc.name);
      if (!tool) {
        toolResultMessages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: `Error: Tool "${tc.name}" not found.`,
        });
        sm.consecutiveToolErrors++;
      } else {
        try {
          const result = await tool.execute(params, tools.context());
          renderer.showToolResult(result);
          sm.consecutiveToolErrors = 0;
          toolResultMessages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: result,
          });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          renderer.showError(`Tool error: ${errMsg}`);
          sm.consecutiveToolErrors++;
          toolResultMessages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: `Error: ${errMsg}`,
          });
        }
      }
    }

    // Check error threshold
    if (sm.consecutiveToolErrors >= maxRetries) {
      sm.taskState = 'ERROR';
      stateMachine.state = 'ERROR';
      renderer.showError(
        `Agent reached ${maxRetries} consecutive tool errors. Entering ERROR state.`,
      );
      break;
    }

    // Add tool results to context and continue
    messages.push(...toolResultMessages);
    renderer.startSpinner('Processing tool results');
    depth++;
  }

  renderer.finalize();

  // If we exited the loop without a final text response (depth limit or error threshold),
  // make one final call without tools so the LLM can summarize results for the user
  const needsFinalResponse = fullResponseText.trim() === '' && sm.taskState !== 'ERROR';
  const hitDepthLimit = depth >= maxDepth;

  if (hitDepthLimit) {
    renderer.showInfo(`[Max tool depth (${maxDepth}) reached — asking for summary]`);
  }

  if (needsFinalResponse || hitDepthLimit) {
    messages.push({
      role: 'user',
      content: hitDepthLimit
        ? 'You have reached the tool call limit. Summarize what you accomplished and what still needs to be done.'
        : 'Summarize the results of your actions for the user.',
    });
    renderer.startSpinner();
    for await (const chunk of provider.stream(messages, { temperature: 0.7 })) {
      if (chunk.type === 'text') {
        renderer.onToken(chunk.text);
        fullResponseText += chunk.text;
      } else if (chunk.type === 'usage') {
        totalInputTokens += chunk.input_tokens;
        totalOutputTokens += chunk.output_tokens;
      }
    }
    renderer.finalize();
  }

  // Parse intent from full response
  const meta = parseMetadataLine(fullResponseText);
  if (meta) {
    const prevState = stateMachine.state;
    stateMachine.transition(meta.intent);
    sm.taskState = stateMachine.state;
    fullResponseText = stripMetadataLine(fullResponseText);
    if (prevState !== sm.taskState) {
      renderer.showStateChange(prevState, sm.taskState, meta.intent);
    }
  }

  renderer.showStats(totalInputTokens, totalOutputTokens);

  // Update WM with assistant response
  if (fullResponseText.trim()) {
    wm.add({ role: 'assistant', content: fullResponseText });
  }

  // Track task: save session on first NEW_TASK, set title from user message
  if (meta?.intent === 'NEW_TASK') {
    sm.currentTask = userMessage.slice(0, 200);
    ltm.saveSession(sessionId, config.userName, null);
    // Auto-title from first user message (first 50 chars trimmed)
    const autoTitle = userMessage.slice(0, 50).trim();
    ltm.updateSessionTitle(sessionId, autoTitle);
  }

  if (sm.taskState === 'DONE' || sm.taskState === 'ERROR') {
    ltm.endSession(sessionId, sm.currentTask);
  }

  // Context window percentage — update in DB and show status bar
  const ctxPct = config.contextWindowTokens > 0
    ? Math.min(100, Math.round((wm.tokenCount() / config.contextWindowTokens) * 100))
    : 0;
  ltm.updateSessionCtxPct(sessionId, ctxPct);
  renderer.showContextBar(wm.tokenCount(), config.contextWindowTokens);

  // Background: extract sticky facts (session-scoped)
  extractAndSaveFactsAsync(provider, [...messages], ltm, sessionId);

  // Summarize if WM is full
  await summarizeIfNeeded(provider, wm, ltm, sessionId);
}

export function createReadlineInput(
  rl: readline.Interface,
): (prompt: string) => Promise<boolean> {
  return (promptText: string): Promise<boolean> => {
    return new Promise((resolve) => {
      rl.question(promptText, (answer) => {
        resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
      });
    });
  };
}
