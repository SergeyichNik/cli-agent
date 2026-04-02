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
import { APIConnectionError, AuthenticationError, RateLimitError, APIError } from 'openai';

async function main(): Promise<void> {
  const args = parseArgs();

  // Load or create user config
  let config = userExists(args.user)
    ? loadConfig(args.user)
    : await runFirstRunWizard(args.user);

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

  // Create session ID
  const sessionId =
    args.resume ??
    new Date()
      .toISOString()
      .replace('T', '_')
      .replace(/:/g, '')
      .slice(0, 15);

  // Set up sessions directory for logging
  const sessionsDir = getUserSessionsDir(args.user);
  mkdirSync(sessionsDir, { recursive: true });

  // Init memory
  const ltm = new LongTermMemory(getUserLtmPath(args.user));
  const wm = new WorkingMemory(config.contextWindowTokens);
  const sm = new SessionMemory(sessionId);

  // Register tools
  const tools = new ToolRegistry();
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

  // Set up readline for multi-line input (Shift+Enter via escape sequence is terminal-dependent)
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  const confirmFn = (prompt: string): Promise<boolean> =>
    new Promise((resolve) => {
      rl.question(prompt, (ans) => {
        resolve(ans.toLowerCase() === 'y' || ans.toLowerCase() === 'yes');
      });
    });

  console.log(`\x1b[32mCLI Agent ready\x1b[0m — user: ${config.userName}, provider: ${config.provider}, model: ${config.model}`);
  console.log(`Session: ${sessionId}  |  Type your message. Ctrl+C to exit.\n`);

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
        console.log(`Task state: ${sm.taskState}`);
        askUser();
        return;
      }

      if (message === '/facts') {
        const facts = ltm.getFacts();
        console.log('Stored facts:');
        for (const f of facts) console.log(`  ${f.key}: ${f.value}`);
        askUser();
        return;
      }

      if (message === '/invariants') {
        console.log('\x1b[1mBuilt-in (code-enforced):\x1b[0m');
        console.log('  • shell: blocks rm -rf /, sudo, dd, mkfs, >/dev');
        console.log('  • write_file: blocks writes outside cwd');
        const custom = config.invariants ?? [];
        console.log(`\n\x1b[1mCustom (from config.json) [${custom.length}]:\x1b[0m`);
        if (custom.length === 0) {
          console.log('  (none — add "invariants": [...] to data/users/<name>/config.json)');
        } else {
          custom.forEach((inv, i) => console.log(`  ${i + 1}. ${inv}`));
        }
        askUser();
        return;
      }

      if (message === '/help') {
        console.log('Commands: /help  /state  /facts  /invariants  /exit');
        askUser();
        return;
      }

      try {
        await runAgentTurn(message, {
          provider,
          wm,
          ltm,
          sm,
          tools,
          config,
          renderer,
          debug: args.debug,
          confirmFn,
        });
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
      askUser();
    });
  };

  // Handle Ctrl+C gracefully
  rl.on('close', () => {
    console.log('\nGoodbye!');
    ltm.close();
    process.exit(0);
  });

  askUser();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
