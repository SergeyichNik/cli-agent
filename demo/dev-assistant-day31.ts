#!/usr/bin/env tsx
/**
 * День 31 — Ассистент разработчика
 *
 * Демонстрирует три возможности:
 *   1. MCP git — получение текущей ветки
 *   2. RAG     — индексация docs/ + README.md, семантический поиск
 *   3. /help   — ответы на вопросы о проекте через DeepSeek + RAG
 *
 * Требует:
 *   - Ollama с nomic-embed-text (или другой embedding-провайдер в .agent/config.json)
 *   - DEEPSEEK_API_KEY в env или ~/.config/agent/secrets.json
 *
 * Usage:
 *   npm run demo:day31
 *   npm run demo:day31 -- --question "Как добавить MCP сервер?"
 */

import path from 'path';
import { execSync } from 'child_process';
import { existsSync, readdirSync, statSync, readFileSync } from 'fs';
import { SearchDB } from '../mcp-servers/search/db.js';
import { createProvider as createEmbeddingProvider, type EmbeddingConfig } from '../mcp-servers/search/embeddings.js';
import { chunkStructural, truncateToTokens } from '../mcp-servers/search/chunker.js';
import { loadProjectConfig } from '../src/agent/config.js';
import { loadSecrets } from '../src/agent/secrets.js';
import { DeepSeekProvider } from '../src/providers/deepseek.js';
import type { Message } from '../src/providers/base.js';

// ── Config ─────────────────────────────────────────────────────────────────

const TOP_K = 6;
const MIN_SCORE = 0.3;

const DEMO_QUESTIONS = [
  'Как добавить новый встроенный MCP сервер?',
  'Где хранятся API ключи и почему не в git?',
  'Какие slash-команды доступны в сессии агента?',
  'Как переключить провайдер на DeepSeek?',
];

const SYSTEM_PROMPT = `Ты — ассистент разработчика, отвечающий на вопросы о проекте CLI Agent.
Отвечай строго по предоставленному контексту из документации.
Если ответ есть в контексте — отвечай кратко, по делу, на русском языке.
Если контекст не содержит ответа — напиши "Информация не найдена в документации."
Никогда не придумывай факты сверх документации.`;

// ── Colors ─────────────────────────────────────────────────────────────────

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

function step(label: string, value: string) {
  console.log(`  ${c.gray}${label}:${c.reset} ${c.cyan}${value}${c.reset}`);
}

function ok(msg: string) {
  console.log(`  ${c.green}✓${c.reset} ${msg}`);
}

function info(msg: string) {
  console.log(`  ${c.dim}${msg}${c.reset}`);
}

// ── Setup ──────────────────────────────────────────────────────────────────

const projectRoot = process.cwd();
const dbPath = path.join(projectRoot, '.agent', 'data', 'search.db');

const rawArgs = process.argv.slice(2);
const questionIdx = rawArgs.indexOf('--question');
const singleQuestion = questionIdx !== -1 ? rawArgs[questionIdx + 1] : null;

const config = loadProjectConfig(projectRoot);
const secrets = loadSecrets();

const apiKey = secrets.deepseek?.apiKey ?? process.env.DEEPSEEK_API_KEY ?? '';
if (!apiKey) {
  console.error(`${c.red}✗ DEEPSEEK_API_KEY не найден.${c.reset} Добавьте в ~/.config/agent/secrets.json или env.`);
  process.exit(1);
}

const deepseek = new DeepSeekProvider(apiKey, config.model ?? 'deepseek-v4-flash');

const e = config.embeddingProvider;
const embProvider = createEmbeddingProvider({
  type: e?.type ?? 'ollama',
  model: e?.model ?? 'nomic-embed-text',
  url: e?.url,
  apiKey: e?.apiKey,
} as EmbeddingConfig);

const db = new SearchDB(dbPath);

// ── Helpers ────────────────────────────────────────────────────────────────

function walkMdFiles(dir: string, base: string): string[] {
  if (!existsSync(dir)) return [];
  const results: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      results.push(...walkMdFiles(full, base));
    } else if (name.endsWith('.md')) {
      results.push(path.relative(base, full));
    }
  }
  return results;
}

function float32ToBuffer(arr: number[]): Buffer {
  const f32 = new Float32Array(arr);
  return Buffer.from(f32.buffer);
}

async function indexDocFiles(files: string[]): Promise<number> {
  const indexed = new Set(db.getIndexedSources());
  const toIndex = files.filter(f => !indexed.has(f) && existsSync(path.join(projectRoot, f)));

  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let frameIdx = 0;

  for (const rel of files) {
    if (indexed.has(rel)) {
      console.log(`  ${c.dim}⊙ ${rel} (cached)${c.reset}`);
      continue;
    }
    if (!existsSync(path.join(projectRoot, rel))) continue;

    let spinInterval = setInterval(() => {
      process.stdout.write(`\r  ${c.cyan}${frames[frameIdx++ % frames.length]}${c.reset} ${rel} — embedding...`);
    }, 80);

    const content = readFileSync(path.join(projectRoot, rel), 'utf8');
    const chunks = chunkStructural(content, rel);
    const texts = chunks.map(ch => truncateToTokens(ch.content));
    const embeddings = await embProvider.embed(texts);
    const now = Date.now();

    const rows = chunks.map((ch, i) => ({
      id: `${rel}:structural:${ch.chunkIndex}`,
      source: rel,
      title: path.basename(rel),
      section: ch.section,
      strategy: 'structural' as const,
      chunk_index: ch.chunkIndex,
      content: ch.content,
      token_count: ch.tokenCount,
      embedding: float32ToBuffer(embeddings[i]),
      indexed_at: now,
    }));

    db.insertChunks(rows);
    clearInterval(spinInterval);
    process.stdout.write(`\r\x1b[K`);
    console.log(`  ${c.green}✓${c.reset} ${rel} ${c.dim}(${chunks.length} chunks)${c.reset}`);
  }

  return files.length;
}

async function search(query: string): Promise<Array<{ source: string; content: string; score: number }>> {
  const [queryEmb] = await embProvider.embed([query]);
  const f32 = new Float32Array(queryEmb);
  return db.search(f32, TOP_K, 'structural', undefined, MIN_SCORE);
}

async function streamAnswer(messages: Message[]): Promise<void> {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let frameIdx = 0;
  const spinInterval = setInterval(() => {
    process.stdout.write(`\r${c.cyan}${frames[frameIdx++ % frames.length]}${c.reset} Генерирую ответ...`);
  }, 80);

  let firstToken = true;
  for await (const chunk of deepseek.stream(messages, { temperature: 0.2 })) {
    if (chunk.type === 'text') {
      if (firstToken) {
        clearInterval(spinInterval);
        process.stdout.write('\r\x1b[K\n');
        firstToken = false;
      }
      process.stdout.write(chunk.text);
    }
  }
  if (firstToken) clearInterval(spinInterval);
  console.log('\n');
}

async function answerQuestion(question: string): Promise<void> {
  console.log(`\n  ${c.bold}${c.white}❯ ${question}${c.reset}`);

  const results = await search(question);
  if (results.length === 0) {
    console.log(`  ${c.yellow}Релевантных чанков не найдено (minScore=${MIN_SCORE})${c.reset}`);
    return;
  }

  info(`Найдено чанков: ${results.length} (topK=${TOP_K}, minScore=${MIN_SCORE})`);
  for (const r of results) {
    info(`  [${r.score.toFixed(3)}] ${r.source}`);
  }
  console.log();

  const context = results.map((r, i) => `--- [${i + 1}] ${r.source} (score: ${r.score.toFixed(3)}) ---\n${r.content}`).join('\n\n');

  const messages: Message[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Контекст из документации:\n\n${context}\n\n---\n\nВопрос: ${question}` },
  ];

  process.stdout.write(`  ${c.green}`);
  await streamAnswer(messages);
  process.stdout.write(c.reset);
}

// ── Main ───────────────────────────────────────────────────────────────────

console.log('');
console.log(`${c.bold}╔══════════════════════════════════════════════╗${c.reset}`);
console.log(`${c.bold}║   День 31 — Ассистент разработчика           ║${c.reset}`);
console.log(`${c.bold}╚══════════════════════════════════════════════╝${c.reset}`);

// ── 1. MCP Git — текущая ветка ─────────────────────────────────────────────

header('1. MCP Git — текущая ветка');
try {
  const branch = execSync('git branch --show-current', { encoding: 'utf8', cwd: projectRoot }).trim();
  const commitCount = execSync('git rev-list --count HEAD', { encoding: 'utf8', cwd: projectRoot }).trim();
  const lastCommit = execSync('git log -1 --format="%s"', { encoding: 'utf8', cwd: projectRoot }).trim();
  step('ветка', branch || '(detached HEAD)');
  step('коммитов', commitCount);
  step('последний коммит', lastCommit);
  ok('git__git_is_repo → ветка получена');
} catch {
  console.log(`  ${c.yellow}не git-репозиторий${c.reset}`);
}

// ── 2. RAG — документация проекта ─────────────────────────────────────────

header('2. RAG — индексация документации');

const docFiles = [
  ...walkMdFiles(path.join(projectRoot, 'docs'), projectRoot),
  ...(existsSync(path.join(projectRoot, 'README.md')) ? ['README.md'] : []),
];

if (docFiles.length === 0) {
  console.log(`  ${c.red}✗ docs/ и README.md не найдены${c.reset}`);
  process.exit(1);
}

console.log(`  ${c.dim}Файлы для индексации:${c.reset}`);
for (const f of docFiles) info(`  ${f}`);

try {
  const indexed = await indexDocFiles(docFiles);
  ok(`Проиндексировано файлов: ${indexed}`);
  const stats = db.getChunkStats('structural');
  step('чанков в индексе', String(stats.count));
  step('стратегия', 'structural');
} catch (err: any) {
  console.log(`  ${c.red}✗ Ошибка индексации: ${err.message}${c.reset}`);
  console.log(`  ${c.dim}Убедитесь что Ollama запущена: ollama serve${c.reset}`);
  process.exit(1);
}

// ── 3. /help — вопросы о проекте ──────────────────────────────────────────

header('3. /help — вопросы о проекте');
console.log(`  ${c.dim}Провайдер: ${c.reset}${c.cyan}DeepSeek ${config.model ?? 'deepseek-v4-flash'}${c.reset}`);

const questions = singleQuestion ? [singleQuestion] : DEMO_QUESTIONS;

for (const q of questions) {
  await answerQuestion(q);
}

console.log(`${c.green}${c.bold}✓ Демонстрация завершена${c.reset}`);
console.log(`  ${c.dim}Команда в агенте:${c.reset} ${c.cyan}/help <вопрос>${c.reset}\n`);
