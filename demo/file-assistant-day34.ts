#!/usr/bin/env tsx
/**
 * День 34 — Файловый ассистент
 *
 * Демонстрирует два сценария активной работы с файлами:
 *   A. Синхронизация документации — агент читает код и обновляет CLAUDE.md
 *   B. Поиск использований API — агент сам находит все места использования
 *      LongTermMemory и создаёт docs/ltm-usage.md
 *
 * Агент сам инициирует работу с файлами — задача ставится на уровне цели.
 *
 * Требует: DEEPSEEK_API_KEY в env или ~/.config/agent/secrets.json
 *
 * Usage:
 *   npm run demo:day34
 *   npm run demo:day34 -- --scenario A
 *   npm run demo:day34 -- --scenario B
 */

import path from 'path';
import { readFile, writeFile, readdir, stat, mkdir } from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { loadSecrets } from '../src/agent/secrets.js';
import { DeepSeekProvider } from '../src/providers/deepseek.js';
import type { Message } from '../src/providers/base.js';

const execFileAsync = promisify(execFile);

// ── Config ─────────────────────────────────────────────────────────────────

const PROJECT_ROOT = process.cwd();
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.agent']);

const SYSTEM_PROMPT = `Ты — файловый ассистент проекта. Твоя задача — самостоятельно работать с файлами:
читать, искать, анализировать и изменять их.

Правила:
- Сам инициируй чтение нужных файлов, не жди подсказок
- При поиске используй grep_files и find_files, а не угадывай пути
- Всегда читай файл перед изменением
- Когда задача выполнена — скажи что сделано и какие файлы затронуты
- Пиши на русском языке`;

// ── Colors & UI ─────────────────────────────────────────────────────────────

const c = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  cyan:    '\x1b[36m',
  blue:    '\x1b[34m',
  gray:    '\x1b[90m',
  white:   '\x1b[97m',
  magenta: '\x1b[35m',
  red:     '\x1b[31m',
};

function header(text: string) {
  console.log(`\n${c.bold}━━━ ${text} ━━━${c.reset}`);
}
function ok(msg: string)     { console.log(`  ${c.green}✓${c.reset} ${msg}`); }
function info(msg: string)   { console.log(`  ${c.dim}${msg}${c.reset}`); }
function warn(msg: string)   { console.log(`  ${c.yellow}⚠${c.reset}  ${msg}`); }
function toolLog(name: string, args: string) {
  console.log(`  ${c.magenta}⚙${c.reset}  ${c.bold}${name}${c.reset}(${c.dim}${args}${c.reset})`);
}

function startSpinner(label: string): () => void {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const t = setInterval(() => {
    process.stdout.write(`\r  ${c.cyan}${frames[i++ % frames.length]}${c.reset} ${label}`);
  }, 80);
  return () => { clearInterval(t); process.stdout.write('\r\x1b[K'); };
}

// ── File helpers ────────────────────────────────────────────────────────────

function globToRegex(glob: string): RegExp {
  const regexStr = glob
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '\x00')
    .replace(/\*/g, '[^/]*')
    .replace(/\x00/g, '.*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`^${regexStr}$`);
}

async function walkFiles(dir: string, results: string[] = []): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walkFiles(full, results);
    else if (entry.isFile()) results.push(full);
  }
  return results;
}

// ── Tool implementations ────────────────────────────────────────────────────

async function toolReadFile(filePath: string): Promise<string> {
  const abs = path.resolve(PROJECT_ROOT, filePath);
  return readFile(abs, 'utf-8');
}

async function toolWriteFile(filePath: string, content: string): Promise<string> {
  const abs = path.resolve(PROJECT_ROOT, filePath);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf-8');
  return `Written ${content.length} bytes to ${filePath}`;
}

async function toolListDirectory(dirPath: string): Promise<string> {
  const abs = path.resolve(PROJECT_ROOT, dirPath);
  const entries = await readdir(abs, { withFileTypes: true });
  return entries
    .map((e) => `${e.isDirectory() ? '[dir] ' : '[file]'} ${e.name}`)
    .join('\n') || '(empty)';
}

async function toolFindFiles(glob: string): Promise<string> {
  const allFiles = await walkFiles(PROJECT_ROOT);
  const pattern = globToRegex(glob);
  const matched = allFiles
    .map((f) => path.relative(PROJECT_ROOT, f))
    .filter((rel) => pattern.test(rel))
    .sort();
  return matched.length ? matched.join('\n') : `No files match: ${glob}`;
}

async function toolGrepFiles(
  pattern: string,
  glob?: string,
  isRegex = false,
  contextLines = 0,
  maxResults = 80,
): Promise<string> {
  const allFiles = await walkFiles(PROJECT_ROOT);
  const fileFilter = glob ? globToRegex(glob) : null;
  const candidates = allFiles
    .map((f) => ({ abs: f, rel: path.relative(PROJECT_ROOT, f) }))
    .filter(({ rel }) => !fileFilter || fileFilter.test(rel));

  const searchRegex = isRegex
    ? new RegExp(pattern, 'g')
    : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');

  const output: string[] = [];
  let totalMatches = 0;

  for (const { abs, rel } of candidates) {
    if (totalMatches >= maxResults) break;
    let content: string;
    try { content = await readFile(abs, 'utf-8'); } catch { continue; }
    if (content.includes('\x00')) continue;

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      searchRegex.lastIndex = 0;
      if (!searchRegex.test(lines[i])) continue;
      if (totalMatches >= maxResults) break;
      const from = Math.max(0, i - contextLines);
      const to = Math.min(lines.length - 1, i + contextLines);
      for (let j = from; j <= to; j++) {
        output.push(`${rel}:${j + 1}:${j === i ? '>' : ' '} ${lines[j]}`);
      }
      if (contextLines > 0) output.push('---');
      totalMatches++;
    }
  }
  return output.length ? output.join('\n') : `No matches for: ${pattern}`;
}

async function toolGitDiff(filePath?: string): Promise<string> {
  const args = ['diff', '--'];
  if (filePath) args.push(filePath);
  try {
    const { stdout } = await execFileAsync('git', args, { cwd: PROJECT_ROOT, maxBuffer: 2 * 1024 * 1024 });
    return stdout.trim() || 'No changes detected';
  } catch {
    return 'git diff unavailable';
  }
}

// ── Tool definitions (OpenAI-compatible) ────────────────────────────────────

const TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'read_file',
      description: 'Read the contents of a file in the project.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to project root' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'write_file',
      description: 'Write or overwrite a file in the project.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to project root' },
          content: { type: 'string', description: 'Full file content to write' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_directory',
      description: 'List files and directories at a path.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path relative to project root' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'find_files',
      description: 'Find files matching a glob pattern across the project. Skips node_modules, .git, dist.',
      parameters: {
        type: 'object',
        properties: {
          glob: { type: 'string', description: 'Glob pattern, e.g. "**/*.ts", "src/**/*.md"' },
        },
        required: ['glob'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'grep_files',
      description: 'Search for a text pattern across project files. Returns file:line: content.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Text string to search for' },
          glob: { type: 'string', description: 'Glob filter, e.g. "**/*.ts"' },
          isRegex: { type: 'boolean', description: 'Treat pattern as regex' },
          contextLines: { type: 'number', description: 'Lines of context around each match' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'git_diff',
      description: 'Show git diff for a file or all changes.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to diff (optional)' },
        },
      },
    },
  },
];

// ── Agentic loop ────────────────────────────────────────────────────────────

async function runAgent(
  provider: DeepSeekProvider,
  task: string,
  maxDepth = 15,
): Promise<void> {
  const messages: Message[] = [{ role: 'user', content: task }];

  for (let depth = 0; depth < maxDepth; depth++) {
    const stop = startSpinner('Агент думает...');

    let text = '';
    const pendingCalls: Array<{ id: string; name: string; arguments: string }> = [];

    for await (const chunk of provider.stream(messages, { tools: TOOLS, temperature: 0.3 })) {
      if (chunk.type === 'text') text += chunk.text;
      else if (chunk.type === 'tool_call') pendingCalls.push({ id: chunk.id, name: chunk.name, arguments: chunk.arguments });
    }

    stop();

    if (text.trim()) {
      console.log(`\n${c.white}${text}${c.reset}`);
    }

    if (pendingCalls.length === 0) break;

    messages.push({
      role: 'assistant',
      content: text || null,
      tool_calls: pendingCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.arguments },
      })),
    } as Message);

    for (const tc of pendingCalls) {
      let params: Record<string, unknown> = {};
      try { params = JSON.parse(tc.arguments); } catch { params = {}; }

      const preview = tc.arguments.length > 60
        ? tc.arguments.slice(0, 60) + '…'
        : tc.arguments;
      toolLog(tc.name, preview);

      let result = '';
      try {
        switch (tc.name) {
          case 'read_file':
            result = await toolReadFile(params.path as string);
            info(`  → ${result.split('\n').length} строк`);
            break;
          case 'write_file':
            result = await toolWriteFile(params.path as string, params.content as string);
            ok(`  ${result}`);
            break;
          case 'list_directory':
            result = await toolListDirectory((params.path as string) ?? '.');
            info(`  → ${result.split('\n').length} записей`);
            break;
          case 'find_files':
            result = await toolFindFiles(params.glob as string);
            info(`  → ${result.split('\n').length} файлов`);
            break;
          case 'grep_files':
            result = await toolGrepFiles(
              params.pattern as string,
              params.glob as string | undefined,
              params.isRegex as boolean | undefined,
              params.contextLines as number | undefined,
            );
            info(`  → ${result.split('\n').filter((l) => l.includes(':>')).length} совпадений`);
            break;
          case 'git_diff':
            result = await toolGitDiff(params.path as string | undefined);
            info(`  → diff получен`);
            break;
          default:
            result = `Unknown tool: ${tc.name}`;
        }
      } catch (err) {
        result = `Error: ${err instanceof Error ? err.message : String(err)}`;
        warn(`  ${result}`);
      }

      messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
    }
  }
}

// ── Scenarios ───────────────────────────────────────────────────────────────

const SCENARIO_A = `Тебе нужно синхронизировать документацию с кодом.

Прочитай файл src/cli/index.ts и найди там регистрацию builtinMcpServers (объект с ключами — именами серверов).
Прочитай CLAUDE.md и найди секцию про MCP servers.

Сравни список серверов в коде и в документации.
Если они расходятся — обнови секцию в CLAUDE.md так, чтобы она точно отражала реальный код.
После изменения вызови git_diff для CLAUDE.md чтобы показать что изменилось.

Если всё уже синхронизировано — так и скажи и объясни почему.`;

const SCENARIO_B = `Тебе нужно найти все места использования класса LongTermMemory в проекте и задокументировать их.

Используй grep_files чтобы найти все TypeScript файлы где встречается "LongTermMemory".
Для каждого найденного файла прочитай его и определи: как именно используется LongTermMemory в этом файле.

Создай файл docs/ltm-usage.md со следующей структурой:
- Заголовок "# LongTermMemory — карта использований"
- Краткое описание что такое LongTermMemory (из кода)
- Таблица: | Файл | Строки | Роль / что делает |
- Итоговый вывод: где хранится состояние, кто пишет, кто читает

Файл должен быть полезен разработчику, который впервые видит этот код.`;

// ── Main ───────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const scenarioArg = argv[argv.indexOf('--scenario') + 1]?.toUpperCase();

const secrets = loadSecrets();
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY ?? secrets.deepseek?.apiKey ?? '';

if (!DEEPSEEK_KEY) {
  console.error(`${c.red}DEEPSEEK_API_KEY не найден${c.reset}`);
  process.exit(1);
}

const provider = new DeepSeekProvider(DEEPSEEK_KEY, 'deepseek-chat');
// Inject system prompt by extending the provider's stream call
const originalStream = provider.stream.bind(provider);
(provider as unknown as { stream: typeof provider.stream }).stream = (
  messages: Message[],
  options?: Parameters<typeof provider.stream>[1],
) => {
  const withSystem: Message[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...messages,
  ];
  return originalStream(withSystem, options);
};

const runScenario = async (label: string, task: string) => {
  header(`Сценарий ${label}`);
  console.log(`${c.cyan}Задача:${c.reset} ${task.split('\n')[0].trim()}`);
  console.log();
  await runAgent(provider, task);
};

console.log(`\n${c.bold}${c.blue}День 34 — Файловый ассистент${c.reset}`);
console.log(`${c.dim}Агент самостоятельно работает с файлами проекта${c.reset}\n`);

if (!scenarioArg || scenarioArg === 'A') {
  await runScenario('A — Синхронизация документации', SCENARIO_A);
}

if (!scenarioArg || scenarioArg === 'B') {
  await runScenario('B — Карта использований API', SCENARIO_B);
}

header('Готово');
ok('Оба сценария завершены');
