#!/usr/bin/env node

// Load .env before anything else (Node 20.12+ built-in, no dotenv needed)
try {
  process.loadEnvFile('.env');
} catch {
  // .env is optional — silently ignore if missing
}

import readline from 'readline';
import path from 'path';
import { mkdirSync } from 'fs';
import { parseArgs } from './args.js';
import { loadConfig, userExists, getUserLtmPath, getUserSessionsDir } from '../user/profile.js';
import { runFirstRunWizard } from '../user/auth.js';
import { DeepSeekProvider } from '../providers/deepseek.js';
import { LMStudioProvider } from '../providers/lmstudio.js';
import { WorkingMemory } from '../memory/wm.js';
import { LongTermMemory } from '../memory/ltm.js';
import { SessionMemory } from '../memory/sm.js';
import { ToolRegistry } from '../tools/registry.js';
import { readFileTool } from '../tools/builtin/read-file.js';
import { writeFileTool } from '../tools/builtin/write-file.js';
import { listDirTool } from '../tools/builtin/list-dir.js';
import { shellTool } from '../tools/builtin/shell.js';
import { StreamRenderer } from '../ui/stream.js';
import { runAgentTurn } from '../core/agent.js';
import { pickSession } from './session-picker.js';
import { arrowSelect } from '../ui/select.js';
import { APIConnectionError, AuthenticationError, RateLimitError, APIError } from 'openai';

function generateSessionId(): string {
  return new Date()
    .toISOString()
    .replace('T', '_')
    .replace(/:/g, '')
    .slice(0, 15);
}

async function main(): Promise<void> {
  const args = parseArgs();

  // Load or create user config
  if (!userExists(args.user)) {
    await runFirstRunWizard(args.user);
  }
  let config = loadConfig(args.user);

  // Apply .env overrides (lower priority than CLI flags)
  const envProvider = process.env.LLM_PROVIDER as 'deepseek' | 'lmstudio' | undefined;
  const envModel = process.env.LLM_MODEL;
  const envApiKey = process.env.DEEPSEEK_API_KEY;
  const envLmStudioUrl = process.env.LMSTUDIO_BASE_URL;
  const envDeepSeekUrl = process.env.DEEPSEEK_BASE_URL;
  if (envProvider) config = { ...config, provider: envProvider };
  if (envModel) config = { ...config, model: envModel };
  if (envApiKey) config = { ...config, apiKey: envApiKey };

  // Apply CLI overrides (highest priority)
  if (args.provider) config = { ...config, provider: args.provider };
  if (args.model) config = { ...config, model: args.model };

  // Final fallback if nothing set provider
  if (!config.provider) config = { ...config, provider: 'lmstudio' };

  // Create provider
  const lmStudioUrl = envLmStudioUrl ?? 'http://localhost:1234/v1';
  const provider =
    config.provider === 'deepseek'
      ? new DeepSeekProvider(config.apiKey ?? '', config.model, envDeepSeekUrl)
      : new LMStudioProvider(config.model, lmStudioUrl);

  // Set up sessions directory for logging
  const sessionsDir = getUserSessionsDir(args.user);
  mkdirSync(sessionsDir, { recursive: true });

  // Init LTM (needed before session picker)
  const ltm = new LongTermMemory(getUserLtmPath(args.user));

  // --- Session selection ---
  let sessionId: string;
  let isResume = false;
  let resumedTask: import('../core/task-state.js').Task | null = null;

  if (args.resume) {
    // --resume flag: validate session exists
    const existing = ltm.getSession(args.resume);
    if (!existing) {
      console.error(`Session not found: ${args.resume}`);
      ltm.close();
      process.exit(1);
    }
    sessionId = args.resume;
    isResume = true;
  } else {
    // Interactive session picker
    const result = await pickSession(config.userName, ltm);
    if (result.type === 'new') {
      sessionId = generateSessionId();
      isResume = false;
    } else {
      sessionId = result.sessionId;
      isResume = true;
      resumedTask = result.task;
    }
  }

  // Init memory
  const wm = new WorkingMemory(config.contextWindowTokens);
  const sm = new SessionMemory(sessionId);

  // On resume: inject saved summaries into WM as context; restore task state
  if (isResume) {
    const summaries = ltm.getSessionSummaries(sessionId);
    for (const s of summaries) {
      wm.prependSummary(s.summary);
    }
    if (resumedTask) {
      sm.taskMachine.loadTask(resumedTask);
    }
  }

  // Resolve sandbox directory (must be inside the project)
  const rawSandbox = process.env.SANDBOX_DIR ?? './sandbox';
  const sandboxDir = path.resolve(process.cwd(), rawSandbox);
  if (!sandboxDir.startsWith(process.cwd())) {
    console.error(`SANDBOX_DIR must be inside the project root.\n  Got: ${sandboxDir}\n  Root: ${process.cwd()}`);
    process.exit(1);
  }
  mkdirSync(sandboxDir, { recursive: true });

  // Register tools
  const tools = new ToolRegistry();
  tools.sandboxDir = sandboxDir;
  tools.register(readFileTool);
  tools.register(writeFileTool);
  tools.register(listDirTool);
  tools.register(shellTool);

  // Load plugins
  try {
    const pluginsDir = path.join(process.cwd(), 'plugins');
    const { readdirSync } = await import('fs');
    const pluginFiles = readdirSync(pluginsDir).filter((f) =>
      f.endsWith('.js') || f.endsWith('.ts'),
    );
    for (const file of pluginFiles) {
      const mod = await import(path.join(pluginsDir, file)) as { default?: unknown; tools?: unknown[] };
      const pluginTools = (mod.default ?? mod.tools) as Array<typeof readFileTool> | undefined;
      if (Array.isArray(pluginTools)) {
        for (const t of pluginTools) tools.register(t);
      }
    }
  } catch {
    // plugins dir doesn't exist or no plugins — that's fine
  }

  const renderer = new StreamRenderer();

  // Set up readline for multi-line input
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  const confirmFn = async (toolLabel: string): Promise<boolean> => {
    rl.pause();
    const choice = await arrowSelect(`Allow \x1b[1m${toolLabel}\x1b[0m?`, [
      { value: true,  label: '\x1b[32mYes, allow\x1b[0m' },
      { value: false, label: '\x1b[2mNo, skip\x1b[0m' },
    ]);
    rl.resume();
    return choice ?? false;
  };

  const relSandbox = path.relative(process.cwd(), sandboxDir);
  console.log(`\x1b[32mCLI Agent ready\x1b[0m — user: ${config.userName}, provider: ${config.provider}, model: ${config.model}`);
  console.log(`Sandbox: \x1b[33m${relSandbox}/\x1b[0m`);
  console.log(`Session: ${sessionId}${isResume ? '  \x1b[2m(resumed)\x1b[0m' : ''}  |  Type your message. Ctrl+C to exit.\n`);

  // Input loop
  const askUser = (): void => {
    rl.question('\x1b[1mYou:\x1b[0m ', async (input) => {
      const message = input.trim();
      if (!message) {
        askUser();
        return;
      }

      if (message === '/exit' || message === '/quit') {
        console.log('Goodbye!');
        ltm.close();
        rl.close();
        process.exit(0);
      }

      if (message === '/state') {
        const { task, state } = sm.taskMachine;
        if (!task || task.total === 0) {
          console.log(`State: ${state}  (no active task)`);
        } else {
          const stateColor =
            state === 'execution' ? '\x1b[33m' :
            state === 'validation' ? '\x1b[36m' :
            state === 'planning' ? '\x1b[34m' :
            state === 'done' ? '\x1b[32m' :
            state === 'paused' ? '\x1b[2m' : '\x1b[0m';
          console.log(`\x1b[1m◈ Task State\x1b[0m`);
          console.log(`  Task:    ${task.task}`);
          console.log(`  State:   ${stateColor}${state}\x1b[0m`);
          console.log(`  Steps:   ${task.step}/${task.total}`);
          task.plan.forEach((step, i) => {
            const icon =
              i < task.step ? `\x1b[32m✓\x1b[0m` :
              i === task.step ? `${stateColor}●\x1b[0m` :
              `\x1b[2m○\x1b[0m`;
            const text = i === task.step ? step : `\x1b[2m${step}\x1b[0m`;
            const current = i === task.step ? '  \x1b[2m← current\x1b[0m' : '';
            console.log(`  ${icon} ${text}${current}`);
          });
        }
        askUser();
        return;
      }

      if (message === '/facts') {
        const facts = ltm.getFactsBySession(sessionId);
        if (facts.length === 0) {
          console.log('No facts stored for this session yet.');
        } else {
          console.log('Session facts:');
          for (const f of facts) console.log(`  ${f.key}: ${f.value}`);
        }
        askUser();
        return;
      }

      if (message === '/invariants') {
        console.log('\x1b[1mBuilt-in (code-enforced):\x1b[0m');
        console.log('  • shell: blocks rm -rf /, sudo, dd, mkfs, >/dev');
        console.log('  • write_file: blocks writes outside cwd');
        const globalInvariants = config.invariants ?? [];
        console.log(`\n\x1b[1mGlobal (from config.json) [${globalInvariants.length}]:\x1b[0m`);
        if (globalInvariants.length === 0) {
          console.log('  (none — add "invariants": [...] to data/users/<name>/config.json)');
        } else {
          globalInvariants.forEach((inv, i) => console.log(`  ${i + 1}. ${inv}`));
        }
        const sessionInvariants = ltm.getSessionInvariants(sessionId);
        console.log(`\n\x1b[1mSession-local [${sessionInvariants.length}]:\x1b[0m`);
        if (sessionInvariants.length === 0) {
          console.log('  (none — use /invariant <rule> to add one)');
        } else {
          sessionInvariants.forEach((inv, i) => console.log(`  ${i + 1}. ${inv}`));
        }
        askUser();
        return;
      }

      if (message.startsWith('/invariant ')) {
        const rule = message.slice('/invariant '.length).trim();
        if (!rule) {
          renderer.showError('Usage: /invariant <rule text>');
          askUser();
          return;
        }
        ltm.saveSessionInvariant(sessionId, rule);
        renderer.showInfo(`Session invariant added: "${rule}"`);
        askUser();
        return;
      }

      if (message === '/help') {
        console.log('Commands:');
        console.log('  /help                  Show this help');
        console.log('  /state                 Show current task state and plan progress');
        console.log('  /facts                 Show session facts');
        console.log('  /invariants            Show all invariants (global + session)');
        console.log('  /invariant <rule>      Add a session-local invariant rule');
        console.log('  /exit  /quit           Exit the agent');
        askUser();
        return;
      }

      await handleTurn(message);
    });
  };

  const agentDeps = {
    provider, wm, ltm, sm, tools, config, renderer, sessionId,
    debug: args.debug, confirmFn,
  };

  async function presentOptions(options: string[], recommended?: number): Promise<string | null> {
    const CUSTOM = '__custom__';
    rl.pause();
    const choice = await arrowSelect('Choose an option:', [
      ...options.map((o, i) => ({
        value: o,
        label: o,
        hint: i === recommended ? '★ recommended' : undefined,
      })),
      { value: CUSTOM, label: 'Type your own response' },
    ]);
    rl.resume();
    if (choice === null || choice === CUSTOM) return null;
    return choice;
  }

  async function promptExecutionChoice(context: 'start' | 'resume'): Promise<void> {
    const task = sm.taskMachine.task;
    rl.pause();
    let choice: string | null;
    if (context === 'start') {
      choice = await arrowSelect('Plan is ready. What would you like to do?', [
        { value: 'execute', label: '\x1b[32mStart execution\x1b[0m', hint: '★ recommended' },
        { value: 'modify',  label: 'Modify the plan' },
        { value: 'ask',     label: '\x1b[2mAsk a question\x1b[0m' },
      ]);
    } else {
      const stepInfo = task ? `step ${task.step + 1}/${task.total} — "${task.current}"` : 'in progress';
      choice = await arrowSelect(`Resume execution (${stepInfo})?`, [
        { value: 'execute', label: '\x1b[32mContinue execution\x1b[0m', hint: '★ recommended' },
        { value: 'ask',     label: 'Ask / discuss the plan' },
        { value: 'modify',  label: '\x1b[2mModify the plan\x1b[0m' },
      ]);
    }
    rl.resume();
    if (choice === null || choice === 'ask' || choice === 'modify') {
      askUser();
      return;
    }
    const msg = context === 'start'
      ? '[SYSTEM] The user approved the plan. Begin execution now. Start with step 1.'
      : '[SYSTEM] The user wants to continue execution. Resume from the current step exactly where you left off.';
    await handleTurn(msg);
  }

  async function handleTurn(message: string): Promise<void> {
    let result: import('../core/agent.js').AgentTurnResult | undefined;
    try {
      result = await runAgentTurn(message, agentDeps);
    } catch (err) {
      renderer.reset();
      if (err instanceof APIConnectionError) {
        const url = config.provider === 'lmstudio' ? lmStudioUrl : 'https://api.deepseek.com';
        renderer.showError(`Cannot connect to ${config.provider} at ${url}`);
        if (config.provider === 'lmstudio') {
          renderer.showInfo('  → Is LM Studio running? Check: Server > Start Server');
          renderer.showInfo('  → Override URL: LMSTUDIO_BASE_URL=http://... in .env');
        } else {
          renderer.showInfo('  → Check your internet connection');
        }
      } else if (err instanceof AuthenticationError) {
        renderer.showError('Authentication failed — invalid API key');
        renderer.showInfo('  → Set DEEPSEEK_API_KEY in .env or run the first-run wizard');
      } else if (err instanceof RateLimitError) {
        renderer.showError('Rate limit reached');
        renderer.showInfo('  → Wait a moment before sending the next message');
      } else if (err instanceof APIError) {
        renderer.showError(`API error ${err.status}: ${err.message}`);
      } else {
        const errMsg = err instanceof Error ? err.message : String(err);
        renderer.showError(`Agent error: ${errMsg}`);
      }
      if (args.debug && err instanceof Error) console.error(err.stack);
    }

    console.log();

    if (result?.autoContinue) {
      await handleTurn('[SYSTEM] Continue executing the next step of the plan. Pick up exactly where you left off.');
      return;
    }

    if (result?.startedExecution) {
      await promptExecutionChoice('start');
      return;
    }

    if (result?.options?.length) {
      const picked = await presentOptions(result.options, result.recommended);
      if (picked !== null) {
        await handleTurn(picked);
        return;
      }
    }

    askUser();
  };

  // Handle Ctrl+C gracefully
  rl.on('close', () => {
    console.log('\nGoodbye!');
    ltm.close();
    process.exit(0);
  });

  if (isResume && sm.taskMachine.state === 'execution') {
    await promptExecutionChoice('resume');
  } else {
    askUser();
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
