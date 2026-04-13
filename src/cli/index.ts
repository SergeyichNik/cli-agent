#!/usr/bin/env node

// Load .env before anything else (Node 20.12+ built-in, no dotenv needed)
try {
  process.loadEnvFile('.env');
} catch {
  // .env is optional — silently ignore if missing
}

import readline from 'readline';
import path from 'path';
import { mkdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import os from 'os';
import { parseArgs } from './args.js';
import { runInit } from './init.js';
import { loadProjectConfig, getAgentDataDir, isAgentProject } from '../agent/config.js';
import { loadSecrets } from '../agent/secrets.js';
import { DeepSeekProvider } from '../providers/deepseek.js';
import { LMStudioProvider } from '../providers/lmstudio.js';
import { WorkingMemory } from '../memory/wm.js';
import { LongTermMemory } from '../memory/ltm.js';
import { SessionMemory } from '../memory/sm.js';
import { ToolRegistry } from '../tools/registry.js';
import { shellTool } from '../tools/builtin/shell.js';
import { McpClient } from '../mcp/client.js';
import { StreamRenderer } from '../ui/stream.js';
import { BottomBar } from '../ui/bottom-bar.js';
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
  const parsedArgs = parseArgs();

  // Handle init subcommand
  if (parsedArgs.subcommand === 'init') {
    await runInit(process.cwd());
    return;
  }

  const args = parsedArgs;

  // Verify this is an initialized agent project
  const projectRoot = process.cwd();
  if (!isAgentProject(projectRoot)) {
    console.error("No agent project found. Run 'agent init' to initialize.");
    process.exit(1);
  }

  // Load project config (non-sensitive)
  let projectConfig = loadProjectConfig(projectRoot);

  // CLI flags override project config
  if (args.provider) projectConfig = { ...projectConfig, provider: args.provider };
  if (args.model) projectConfig = { ...projectConfig, model: args.model };

  // Load secrets from global store (~/.config/agent/secrets.json)
  const secrets = loadSecrets();

  // Resolve API key: secrets file → env var fallback (for CI/CD)
  const apiKey =
    secrets[projectConfig.provider]?.apiKey ??
    (projectConfig.provider === 'deepseek' ? process.env.DEEPSEEK_API_KEY : undefined);

  if (projectConfig.provider === 'deepseek' && !apiKey) {
    console.error(
      "DeepSeek API key not found. Run 'agent init' or edit ~/.config/agent/secrets.json",
    );
    process.exit(1);
  }

  // Resolve provider URLs: secrets → env vars → defaults
  const lmStudioUrl =
    secrets.lmstudio?.baseUrl ?? process.env.LMSTUDIO_BASE_URL ?? 'http://localhost:1234/v1';
  const deepSeekUrl = secrets.deepseek?.baseUrl ?? process.env.DEEPSEEK_BASE_URL;

  // Create LLM provider
  const provider =
    projectConfig.provider === 'deepseek'
      ? new DeepSeekProvider(apiKey ?? '', projectConfig.model, deepSeekUrl)
      : new LMStudioProvider(projectConfig.model, lmStudioUrl);

  // Sandbox = project root (the entire initialized folder is the boundary)
  const sandboxDir = projectRoot;

  // Data lives in .agent/data/
  const dataDir = getAgentDataDir(projectRoot);
  const sessionsDir = path.join(dataDir, 'sessions');
  const ltmPath = path.join(dataDir, 'ltm.db');
  mkdirSync(sessionsDir, { recursive: true });

  // Resolve path to installed package root (for built-in MCP servers)
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

  // Built-in MCP servers with paths resolved from package location
  const builtinMcpServers: Record<string, string> = {
    files: `node ${path.join(packageRoot, 'dist/mcp-servers/files/index.js')}`,
    git: `node ${path.join(packageRoot, 'dist/mcp-servers/git/index.js')}`,
    search: `node ${path.join(packageRoot, 'dist/mcp-servers/search/index.js')}`,
  };
  const linearApiKey = secrets.linear?.apiKey ?? process.env.LINEAR_API_KEY;
  if (linearApiKey) {
    process.env.LINEAR_API_KEY = linearApiKey; // ensure MCP server receives it
    builtinMcpServers.linear = `node ${path.join(packageRoot, 'dist/mcp-servers/linear/index.js')}`;
  }

  // Merge: built-in + user-defined from .agent/config.json
  const allMcpServers = { ...builtinMcpServers, ...projectConfig.mcpServers };

  // Build runtime config compatible with existing UserConfig interface
  const config = {
    userName: os.userInfo().username,
    preferredLanguage: projectConfig.preferredLanguage,
    responseStyle: projectConfig.responseStyle,
    provider: projectConfig.provider,
    model: projectConfig.model,
    apiKey: apiKey ?? '',
    contextWindowTokens: projectConfig.contextWindowTokens,
    invariants: projectConfig.invariants,
    maxToolDepth: projectConfig.maxToolDepth,
    maxToolRetries: projectConfig.maxToolRetries,
    mcpServers: allMcpServers,
  };

  // Init LTM (needed before session picker)
  const ltm = new LongTermMemory(ltmPath);

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

  // Register tools
  const tools = new ToolRegistry();
  tools.sandboxDir = sandboxDir;
  tools.register(shellTool);

  // Start MCP servers and register their tools
  const mcpClient = new McpClient();
  const mcpTools = await mcpClient.initialize(config, sandboxDir);
  for (const t of mcpTools) tools.register(t);

  // Load plugins
  try {
    const pluginsDir = path.join(process.cwd(), 'plugins');
    const { readdirSync } = await import('fs');
    const pluginFiles = readdirSync(pluginsDir).filter((f) =>
      f.endsWith('.js') || f.endsWith('.ts'),
    );
    for (const file of pluginFiles) {
      const mod = await import(path.join(pluginsDir, file)) as { default?: unknown; tools?: unknown[] };
      const pluginTools = (mod.default ?? mod.tools) as import('../tools/base.js').Tool[] | undefined;
      if (Array.isArray(pluginTools)) {
        for (const t of pluginTools) tools.register(t);
      }
    }
  } catch {
    // plugins dir doesn't exist or no plugins — that's fine
  }

  const renderer = new StreamRenderer();
  const bottomBar = new BottomBar();

  // Set up readline for multi-line input
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  const confirmFn = async (toolLabel: string): Promise<boolean> => {
    rl.pause();
    // collapseLabel: show only the tool name (strip args) in the collapsed summary
    const toolName = toolLabel.replace(/\(.*/, '');
    const choice = await arrowSelect(`Allow \x1b[1m${toolLabel}\x1b[0m?`, [
      { value: true,  label: '\x1b[32mYes, allow\x1b[0m' },
      { value: false, label: '\x1b[2mNo, skip\x1b[0m' },
    ], 0, 0, true, `Allow \x1b[1m${toolName}\x1b[0m`);
    rl.resume();
    return choice ?? false;
  };

  console.log(`\x1b[32mAgent ready\x1b[0m — user: ${config.userName}, provider: ${config.provider}, model: ${config.model}`);
  console.log(`Workspace: \x1b[33m${projectRoot}/\x1b[0m`);
  console.log(`Session: ${sessionId}${isResume ? '  \x1b[2m(resumed)\x1b[0m' : ''}  |  Type your message. Ctrl+C to exit.\n`);

  // Input loop
  const askUser = (): void => {
    bottomBar.draw();
    rl.question('> ', async (input) => {
      const message = input.trim();
      if (!message) {
        askUser();
        return;
      }

      if (message === '/exit' || message === '/quit') {
        console.log('Goodbye!');
        ltm.close();
        rl.close();
        await mcpClient.shutdown();
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

      if (message === '/mcp' || message.startsWith('/mcp ')) {
        const filter = message.startsWith('/mcp ') ? message.slice(5).trim() : null;
        const mcpTools = tools.list().filter((t) => t.name.includes('__'));

        // Group by server name
        const byServer = new Map<string, typeof mcpTools>();
        for (const t of mcpTools) {
          const [serverName] = t.name.split('__');
          if (filter && serverName !== filter) continue;
          if (!byServer.has(serverName)) byServer.set(serverName, []);
          byServer.get(serverName)!.push(t);
        }

        if (byServer.size === 0) {
          const hint = filter ? ` "${filter}"` : '';
          console.log(`No MCP tools found${hint}. Configured servers: ${Object.keys(config.mcpServers ?? {}).join(', ') || '(none)'}`);
        } else {
          for (const [serverName, serverTools] of byServer) {
            console.log(`\n\x1b[1m[MCP: ${serverName}]\x1b[0m  \x1b[2m${config.mcpServers?.[serverName] ?? ''}\x1b[0m`);
            for (const t of serverTools) {
              const toolShortName = t.name.slice(serverName.length + 2);
              const confirm = t.requiresConfirmation ? ' \x1b[33m[confirm]\x1b[0m' : '';
              console.log(`  \x1b[36m${toolShortName}\x1b[0m${confirm}`);
              console.log(`    \x1b[2m${t.description}\x1b[0m`);
            }
          }
        }
        console.log();
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
        console.log('  /mcp                   List all MCP tools from connected servers');
        console.log('  /mcp <server>          List tools from a specific MCP server');
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
    bottomBar.drawStatus();
    const choice = await arrowSelect('Choose an option:', [
      ...options.map((o, i) => ({
        value: o,
        label: o,
        hint: i === recommended ? '★ recommended' : undefined,
      })),
      { value: CUSTOM, label: 'Type your own response' },
    ], 0, 1);
    rl.resume();
    if (choice === null || choice === CUSTOM) return null;
    return choice;
  }

  async function promptStepChoice(): Promise<void> {
    await handleTurn('[SYSTEM] Continue executing the next step of the plan. Pick up exactly where you left off.');
  }

  async function promptValidationChoice(): Promise<void> {
    sm.taskMachine.transition('CONFIRM'); // execution → validation
    renderer.showStateChange('execution', 'validation', 'CONFIRM');
    await handleTurn('[SYSTEM] All steps are complete. Begin validation now. Review what was implemented against the plan.');
  }

  async function promptDoneChoice(): Promise<void> {
    sm.taskMachine.transition('CONFIRM'); // validation → done
    renderer.showStateChange('validation', 'done', 'CONFIRM');
    ltm.endSession(sessionId, sm.taskMachine.task?.task ?? null);
    bottomBar.patchTaskState('done');
    if (sm.taskMachine.task) {
      renderer.showTaskProgress(sm.taskMachine.task); // ✓ All N steps completed
    }
    askUser();
  }

  async function promptExecutionChoice(context: 'start' | 'resume'): Promise<void> {
    const task = sm.taskMachine.task;
    rl.pause();
    bottomBar.drawStatus();
    let choice: string | null;
    if (context === 'start') {
      choice = await arrowSelect('Plan is ready. What would you like to do?', [
        { value: 'execute', label: '\x1b[32mStart execution\x1b[0m', hint: '★ recommended' },
        { value: 'modify',  label: 'Modify the plan' },
        { value: 'ask',     label: '\x1b[2mAsk a question\x1b[0m' },
      ], 0, 1);
    } else {
      const stepInfo = task ? `step ${task.step + 1}/${task.total} — "${task.current}"` : 'in progress';
      choice = await arrowSelect(`Resume execution (${stepInfo})?`, [
        { value: 'execute', label: '\x1b[32mContinue execution\x1b[0m', hint: '★ recommended' },
        { value: 'ask',     label: 'Ask / discuss the plan' },
        { value: 'modify',  label: '\x1b[2mModify the plan\x1b[0m' },
      ], 0, 1);
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

    if (result?.stats) {
      bottomBar.update(result.stats);
    }

    if (result?.stepCompleted || result?.autoContinue) {
      if (result?.stats?.taskState === 'validation') {
        await handleTurn('[SYSTEM] Continue validation. Pick up where you left off.');
      } else {
        const task = sm.taskMachine.task;
        if (task && task.step >= task.total) {
          await promptValidationChoice();
        } else {
          await promptStepChoice();
        }
      }
      return;
    }

    if (result?.validationComplete) {
      await promptDoneChoice();
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
    mcpClient.shutdown().finally(() => process.exit(0));
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
