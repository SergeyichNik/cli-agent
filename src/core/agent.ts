import type { LLMProvider, Message } from '../providers/base.js';
import type { WorkingMemory } from '../memory/wm.js';
import type { LongTermMemory } from '../memory/ltm.js';
import type { SessionMemory } from '../memory/sm.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { UserConfig } from '../user/profile.js';
import type { StreamRenderer } from '../ui/stream.js';
import { parseMetadataLine, stripMetadataLine } from './task-state.js';
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

export interface AgentTurnResult {
  options?: string[];
  recommended?: number;
}

export async function runAgentTurn(userMessage: string, deps: AgentDeps): Promise<AgentTurnResult> {
  const { provider, wm, ltm, sm, tools, config, renderer, sessionId } = deps;

  const systemPrompt = buildSystemPrompt(config, ltm, sessionId, sm.taskMachine.state);
  const messages = buildContext(userMessage, systemPrompt, wm, ltm);

  // Add user message to WM
  wm.add({ role: 'user', content: userMessage });

  // Auto-initialize task if none is active (don't rely on LLM emitting NEW_TASK)
  if (!sm.taskMachine.task) {
    sm.taskMachine.setTask(userMessage.slice(0, 200));
    ltm.saveSession(sessionId, config.userName, null);
    ltm.updateSessionTitle(sessionId, userMessage.slice(0, 50).trim());
  }

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

    // Block all tool calls in planning state — agent must plan first, not act
    if (sm.taskMachine.state === 'planning') {
      renderer.finalize();
      renderer.showInfo('[planning] Tool calls are not allowed in planning state. Provide a plan first.');
      // Return the blocked tool calls as errors so LLM knows
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
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: 'Error: Tool calls are not allowed in planning state. You must present a plan first using {"intent":"CONFIRM","plan":[...]}.',
        });
      }
      renderer.startSpinner();
      depth++;
      continue;
    }

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
        const argsPreview = tc.arguments.slice(0, 80) + (tc.arguments.length > 80 ? '…' : '');
        const confirmed = await deps.confirmFn(`${tc.name}(${argsPreview})`);
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
      sm.taskMachine.forceError();
      renderer.showError(
        `Agent reached ${maxRetries} consecutive tool errors. Entering error state.`,
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
  const needsFinalResponse = fullResponseText.trim() === '' && sm.taskMachine.state !== 'error';
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

  // Parse metadata from full response and update task machine
  let pendingOptions: string[] | undefined;
  let pendingRecommended: number | undefined;
  const meta = parseMetadataLine(fullResponseText);
  if (meta) {
    const prevState = sm.taskMachine.state;

    // On NEW_TASK: reset task entity (mid-session new task)
    if (meta.intent === 'NEW_TASK') {
      sm.taskMachine.setTask(userMessage.slice(0, 200));
      ltm.updateSessionTitle(sessionId, userMessage.slice(0, 50).trim());
    }

    // Accept plan from LLM (only once, when in planning state)
    if (meta.plan && sm.taskMachine.state === 'planning') {
      sm.taskMachine.setPlan(meta.plan);
    }

    // Guard: block invalid transitions even if LLM requested them
    const guard = sm.taskMachine.checkTransitionGuard(meta.intent);
    if (!guard.allowed) {
      renderer.showError(`Transition blocked: ${guard.reason}`);
      // Inject the block reason back so LLM explains refusal to user on next turn
      messages.push({
        role: 'user',
        content: `[SYSTEM] State transition was blocked by the state machine: ${guard.reason} You MUST explain this to the user and refuse their request with clear arguments. Do NOT emit CONFIRM until the conditions are met.`,
      });
      renderer.startSpinner();
      for await (const chunk of provider.stream(messages, { temperature: 0.7 })) {
        if (chunk.type === 'text') {
          renderer.onToken(chunk.text);
          fullResponseText = chunk.text;
        } else if (chunk.type === 'usage') {
          totalInputTokens += chunk.input_tokens;
          totalOutputTokens += chunk.output_tokens;
        }
      }
      renderer.finalize();
    } else {
      // Transition state based on intent
      sm.taskMachine.transition(meta.intent);
    }

    // Mark step complete after state transition
    if (meta.step_done) {
      sm.taskMachine.completeStep();
    }

    fullResponseText = stripMetadataLine(fullResponseText);

    if (prevState !== sm.taskMachine.state) {
      renderer.showStateChange(prevState, sm.taskMachine.state, meta.intent);
    }

    // Persist task state to SQLite
    if (sm.taskMachine.task) {
      ltm.saveTaskState(sessionId, sm.taskMachine.task);
    }

    // Capture options for interactive selection
    if (meta.options) {
      pendingOptions = meta.options;
      pendingRecommended = meta.recommended;
    }
  }

  renderer.showStats(totalInputTokens, totalOutputTokens);

  // Show task progress bar if task is active
  if (sm.taskMachine.task && sm.taskMachine.state !== 'error') {
    renderer.showTaskProgress(sm.taskMachine.task);
  }

  // Update WM with assistant response
  if (fullResponseText.trim()) {
    wm.add({ role: 'assistant', content: fullResponseText });
  }

  if (sm.taskMachine.state === 'done' || sm.taskMachine.state === 'error') {
    ltm.endSession(sessionId, sm.taskMachine.task?.task ?? null);
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

  return { options: pendingOptions, recommended: pendingRecommended };
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
