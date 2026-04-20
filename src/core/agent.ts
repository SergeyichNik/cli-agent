import type { LLMProvider, Message } from '../providers/base.js';
import type { WorkingMemory } from '../memory/wm.js';
import type { LongTermMemory } from '../memory/ltm.js';
import type { SessionMemory } from '../memory/sm.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { UserConfig } from '../user/profile.js';
import type { StreamRenderer } from '../ui/stream.js';
import type { BottomBarStats } from '../ui/bottom-bar.js';
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
  autoContinue?: boolean;
  startedExecution?: boolean;
  stepCompleted?: boolean;
  validationComplete?: boolean;
  stats: BottomBarStats;
}

export async function runAgentTurn(userMessage: string, deps: AgentDeps): Promise<AgentTurnResult> {
  const { provider, wm, ltm, sm, tools, config, renderer, sessionId } = deps;

  const systemPrompt = buildSystemPrompt(config, ltm, sessionId, sm.taskMachine.state, sm.taskMachine.task, tools.sandboxDir, config.compactPrompt);
  const messages = buildContext(userMessage, systemPrompt, wm, ltm, sm.taskMachine.task, sm.taskMachine.state);

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
      tools: config.provider === 'lmstudio' ? [] : tools.listForLLM(),
      temperature: 0.7,
      maxTokens: config.maxOutputTokens,
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
      renderer.showInfo('[planning] Tool calls blocked — emitting plan first.');
      // Add blocked tool call errors to context
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
          content: 'BLOCKED: Tool calls are not allowed in planning state.',
        });
      }
      // Force the LLM to emit CONFIRM + plan immediately — no more looping
      messages.push({
        role: 'user',
        content: '[SYSTEM] You are in PLANNING state and cannot call tools yet. Your next response MUST start with a plan line and nothing else before it:\n{"intent":"CONFIRM","plan":["Step 1: <what you will do>"]}\nAfter transitioning to execution you can call tools freely. Do NOT attempt any tool calls in this response.',
      });
      renderer.startSpinner();
      fullResponseText = '';
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
      break; // let metadata parsing handle the CONFIRM transition
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
        renderer.showError('Tool arguments JSON is invalid (likely truncated — content too large).');
        sm.consecutiveToolErrors++;
        toolResultMessages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: 'Error: Tool arguments could not be parsed — the content is likely too large and was truncated. Split the content into multiple smaller files or smaller write_file calls (max ~200 lines per file).',
        });
        continue;
      }

      // Guard against oversized content before calling MCP
      if (typeof params.content === 'string' && params.content.length > 20_000) {
        renderer.showError(`Content too large (${params.content.length} chars) — split into smaller files.`);
        sm.consecutiveToolErrors++;
        toolResultMessages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: `Error: File content is too large (${params.content.length} chars). Split into multiple focused files of max ~200 lines each.`,
        });
        continue;
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
    renderer.showInfo(`[Max tool depth (${maxDepth}) reached — continuing in next turn]`);
  }

  if (needsFinalResponse || hitDepthLimit) {
    messages.push({
      role: 'user',
      content: hitDepthLimit
        ? '[SYSTEM] Tool call limit reached for this turn. Briefly summarize what you completed in this turn and what still needs to be done. Do NOT re-explain the full plan. Be concise.'
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
  let startedExecution = false;
  let stepCompleted = false;
  let validationComplete = false;
  let meta = parseMetadataLine(fullResponseText);

  // Enforce: in planning state, QUESTION intent must include options
  if (meta && sm.taskMachine.state === 'planning' && meta.intent === 'QUESTION' && !meta.options) {
    messages.push({ role: 'assistant', content: fullResponseText });
    messages.push({
      role: 'user',
      content: '[SYSTEM] Your question did not include answer options. In planning state, EVERY question MUST use the format {"intent":"QUESTION","options":["A","B","C"],"recommended":0} with 3–4 concrete, case-specific options. Re-ask your question now with proper options.',
    });
    fullResponseText = '';
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
    meta = parseMetadataLine(fullResponseText) ?? meta;
  }

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
      // Intercept CONFIRM from validation — let CLI prompt the user instead of auto-transitioning
      if (sm.taskMachine.state === 'validation' && meta.intent === 'CONFIRM') {
        validationComplete = true;
      } else {
        // Transition state based on intent
        sm.taskMachine.transition(meta.intent);
        if (prevState === 'planning' && sm.taskMachine.state === 'execution') {
          startedExecution = true;
        }
      }
    }

    // Mark step complete after state transition
    if (meta.step_done) {
      if (sm.taskMachine.state === 'execution') stepCompleted = true;
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

  // Auto-detect step completion: agent finished in execution state but didn't emit step_done
  // Only when depth limit wasn't hit (agent truly finished its work for this turn)
  if (!stepCompleted && !hitDepthLimit && !startedExecution && sm.taskMachine.state === 'execution' && fullResponseText.trim() && !pendingOptions) {
    stepCompleted = true;
    sm.taskMachine.completeStep();
    if (sm.taskMachine.task) {
      ltm.saveTaskState(sessionId, sm.taskMachine.task);
    }
  }

  // Auto-detect validation completion: agent finished in validation state but didn't emit CONFIRM
  if (!validationComplete && !hitDepthLimit && sm.taskMachine.state === 'validation' && fullResponseText.trim() && !pendingOptions) {
    validationComplete = true;
  }

  // Show task progress bar only during active states (done/error are handled elsewhere)
  if (sm.taskMachine.task && sm.taskMachine.state !== 'error' && sm.taskMachine.state !== 'done' && sm.taskMachine.task.total > 0) {
    renderer.showTaskProgress(sm.taskMachine.task);
  }

  // Update WM with assistant response
  if (fullResponseText.trim()) {
    wm.add({ role: 'assistant', content: fullResponseText });
  }

  if (sm.taskMachine.state === 'done' || sm.taskMachine.state === 'error') {
    ltm.endSession(sessionId, sm.taskMachine.task?.task ?? null);
  }

  // Context window percentage — update in DB
  const ctxPct = config.contextWindowTokens > 0
    ? Math.min(100, Math.round((wm.tokenCount() / config.contextWindowTokens) * 100))
    : 0;
  ltm.updateSessionCtxPct(sessionId, ctxPct);

  // Background: extract sticky facts (session-scoped)
  extractAndSaveFactsAsync(provider, [...messages], ltm, sessionId);

  // Summarize if WM is full
  await summarizeIfNeeded(provider, wm, ltm, sessionId, config.provider === 'lmstudio');

  const autoContinue = hitDepthLimit && (sm.taskMachine.state === 'execution' || sm.taskMachine.state === 'validation');
  const stats: BottomBarStats = {
    inputTokens:  totalInputTokens,
    outputTokens: totalOutputTokens,
    ctxUsed:      wm.tokenCount(),
    ctxMax:       config.contextWindowTokens,
    taskState:    sm.taskMachine.state,
    step:         sm.taskMachine.task?.step  ?? 0,
    total:        sm.taskMachine.task?.total ?? 0,
  };
  return { options: pendingOptions, recommended: pendingRecommended, autoContinue, startedExecution, stepCompleted, validationComplete, stats };
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
