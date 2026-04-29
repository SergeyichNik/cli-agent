#!/usr/bin/env tsx
/**
 * День 33 — Ассистент поддержки пользователей
 *
 * Демонстрирует пайплайн AI-поддержки:
 *   1. Linear CRM  — создание тестового тикета + получение данных
 *   2. RAG          — индексация docs/ + README.md, поиск по тикету
 *   3. DeepSeek     — генерация ответа с учётом контекста тикета
 *   4. Linear CRM  — обновление тикета с ответом поддержки
 *
 * Требует:
 *   - LINEAR_API_KEY в env или ~/.config/agent/secrets.json (linear.apiKey)
 *   - DEEPSEEK_API_KEY в env или ~/.config/agent/secrets.json
 *   - Ollama с nomic-embed-text (или другой embedding-провайдер в .agent/config.json)
 *
 * Usage:
 *   npm run demo:day33
 *   npm run demo:day33 -- --ticket "Как сбросить конфиг агента?"
 */

import path from 'path';
import { existsSync, readdirSync, statSync, readFileSync } from 'fs';
import { SearchDB } from '../mcp-servers/search/db.js';
import { createProvider as createEmbeddingProvider, type EmbeddingConfig } from '../mcp-servers/search/embeddings.js';
import { chunkStructural, truncateToTokens } from '../mcp-servers/search/chunker.js';
import { loadProjectConfig } from '../src/agent/config.js';
import { loadSecrets } from '../src/agent/secrets.js';
import { DeepSeekProvider } from '../src/providers/deepseek.js';
import type { Message } from '../src/providers/base.js';

// ── Config ─────────────────────────────────────────────────────────────────

const TOP_K = 5;
const MIN_SCORE = 0.25;
const LINEAR_API_URL = 'https://api.linear.app/graphql';

const DEMO_TICKET = {
  title: 'agent init fails with permission denied',
  description: `Running \`agent init\` in /home/user/project throws EACCES error.

Steps to reproduce:
1. mkdir /home/user/project && cd /home/user/project
2. agent init
3. Error: EACCES: permission denied, mkdir '/home/user/project/.agent'

Expected: .agent/ folder created successfully
Environment: Ubuntu 22.04, Node 20, agent v1.0`,
  priority: 2, // High
};

const SYSTEM_PROMPT = `Ты — ассистент поддержки пользователей продукта CLI Agent.
Отвечай строго на основе предоставленной документации.
Учитывай контекст тикета: проблему пользователя, шаги воспроизведения, окружение.
Давай конкретные, actionable инструкции. Пиши на русском языке.
Если ответ не найден в документации — так и скажи, не придумывай.`;

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
function ok(msg: string)   { console.log(`  ${c.green}✓${c.reset} ${msg}`); }
function info(msg: string) { console.log(`  ${c.dim}${msg}${c.reset}`); }
function err(msg: string)  { console.log(`  ${c.red}✗${c.reset} ${msg}`); }
function step(label: string, value: string) {
  console.log(`  ${c.gray}${label}:${c.reset} ${c.cyan}${value}${c.reset}`);
}

function startSpinner(label: string): () => void {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const t = setInterval(() => {
    process.stdout.write(`\r  ${c.cyan}${frames[i++ % frames.length]}${c.reset} ${label}`);
  }, 80);
  return () => { clearInterval(t); process.stdout.write('\r\x1b[K'); };
}

// ── Linear helpers ─────────────────────────────────────────────────────────

async function linearQuery<T>(apiKey: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(LINEAR_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: apiKey },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Linear API HTTP error: ${res.status} ${res.statusText}`);
  const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join('; '));
  if (!json.data) throw new Error('Linear API returned no data');
  return json.data;
}

async function getFirstTeam(apiKey: string): Promise<{ id: string; name: string }> {
  const data = await linearQuery<{ teams: { nodes: Array<{ id: string; name: string }> } }>(
    apiKey,
    `query { teams { nodes { id name } } }`,
  );
  const teams = data.teams.nodes;
  if (!teams.length) throw new Error('No Linear teams found');
  return teams[0];
}

async function createIssue(apiKey: string, teamId: string, title: string, description: string, priority: number) {
  const data = await linearQuery<{
    issueCreate: { issue: { id: string; title: string; url: string; state: { name: string } } };
  }>(
    apiKey,
    `mutation CreateIssue($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        issue { id title url state { name } }
      }
    }`,
    { input: { title, teamId, description, priority } },
  );
  return data.issueCreate.issue;
}

async function getIssue(apiKey: string, issueId: string) {
  const data = await linearQuery<{
    issue: {
      id: string; title: string; description: string | null;
      priority: number; state: { name: string }; assignee: { name: string } | null;
      team: { name: string }; url: string;
    };
  }>(
    apiKey,
    `query GetIssue($id: String!) {
      issue(id: $id) {
        id title description priority
        state { name } assignee { name } team { name } url
      }
    }`,
    { id: issueId },
  );
  return data.issue;
}

async function updateIssue(apiKey: string, issueId: string, description: string) {
  const data = await linearQuery<{
    issueUpdate: { issue: { id: string; title: string; url: string } };
  }>(
    apiKey,
    `mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) {
        issue { id title url }
      }
    }`,
    { id: issueId, input: { description } },
  );
  return data.issueUpdate.issue;
}

// ── RAG helpers ────────────────────────────────────────────────────────────

function walkMdFiles(dir: string, base: string): string[] {
  if (!existsSync(dir)) return [];
  const results: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) results.push(...walkMdFiles(full, base));
    else if (name.endsWith('.md')) results.push(path.relative(base, full));
  }
  return results;
}

function float32ToBuffer(arr: number[]): Buffer {
  return Buffer.from(new Float32Array(arr).buffer);
}

// ── Setup ──────────────────────────────────────────────────────────────────

const projectRoot = process.cwd();
const dbPath = path.join(projectRoot, '.agent', 'data', 'search.db');

const argv = process.argv.slice(2);
const ticketIdx = argv.indexOf('--ticket');
const customTicketTitle = ticketIdx !== -1 ? argv[ticketIdx + 1] : null;

const config = loadProjectConfig(projectRoot);
const secrets = loadSecrets();

const LINEAR_KEY = process.env.LINEAR_API_KEY ?? secrets.linear?.apiKey ?? '';
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY ?? secrets.deepseek?.apiKey ?? '';

// ── Main ───────────────────────────────────────────────────────────────────

console.log('');
console.log(`${c.bold}╔══════════════════════════════════════════════╗${c.reset}`);
console.log(`${c.bold}║   День 33 — Ассистент поддержки              ║${c.reset}`);
console.log(`${c.bold}╚══════════════════════════════════════════════╝${c.reset}`);

// ── 0. Credentials ─────────────────────────────────────────────────────────

header('0. Credentials');

if (!LINEAR_KEY) {
  err('LINEAR_API_KEY не найден');
  info('Добавьте в env или ~/.config/agent/secrets.json → linear.apiKey');
  process.exit(1);
}
if (!DEEPSEEK_KEY) {
  err('DEEPSEEK_API_KEY не найден');
  info('Добавьте в env или ~/.config/agent/secrets.json → deepseek.apiKey');
  process.exit(1);
}
ok('LINEAR_API_KEY  ✓');
ok('DEEPSEEK_API_KEY  ✓');

const deepseek = new DeepSeekProvider(DEEPSEEK_KEY, 'deepseek-chat');

const e = config.embeddingProvider;
const embProvider = createEmbeddingProvider({
  type: e?.type ?? 'ollama',
  model: e?.model ?? 'nomic-embed-text',
  url: e?.url,
  apiKey: e?.apiKey,
} as EmbeddingConfig);

const db = new SearchDB(dbPath);

// ── 1. Linear — создать тикет ──────────────────────────────────────────────

header('1. Linear CRM — создание тикета');

let stopSpin = startSpinner('Получаю команды Linear...');
const team = await getFirstTeam(LINEAR_KEY);
stopSpin();
ok(`Команда: ${team.name} (${team.id})`);

const ticketTitle = customTicketTitle ?? DEMO_TICKET.title;
const ticketDescription = customTicketTitle
  ? `Вопрос пользователя: ${customTicketTitle}`
  : DEMO_TICKET.description;
const ticketPriority = customTicketTitle ? 3 : DEMO_TICKET.priority;

stopSpin = startSpinner('Создаю тикет...');
const created = await createIssue(LINEAR_KEY, team.id, ticketTitle, ticketDescription, ticketPriority);
stopSpin();
ok(`Тикет создан: [${created.id}] ${created.title}`);
step('статус', created.state.name);
step('url', created.url);

// ── 2. Linear — получить данные тикета ────────────────────────────────────

header('2. Linear CRM — чтение тикета');

stopSpin = startSpinner('Загружаю детали тикета...');
const ticket = await getIssue(LINEAR_KEY, created.id);
stopSpin();

const PRIORITY_LABEL: Record<number, string> = { 0: 'No priority', 1: 'Urgent', 2: 'High', 3: 'Medium', 4: 'Low' };
ok(`[${ticket.id}] ${ticket.title}`);
step('приоритет', PRIORITY_LABEL[ticket.priority] ?? String(ticket.priority));
step('статус', ticket.state.name);
step('команда', ticket.team.name);
if (ticket.description) {
  console.log(`\n  ${c.dim}Описание:${c.reset}`);
  for (const line of ticket.description.split('\n').slice(0, 6)) {
    info(`  ${line}`);
  }
}

// ── 3. RAG — индексация документации ──────────────────────────────────────

header('3. RAG — индексация документации');

const docFiles = [
  ...walkMdFiles(path.join(projectRoot, 'docs'), projectRoot),
  ...(existsSync(path.join(projectRoot, 'README.md')) ? ['README.md'] : []),
  ...(existsSync(path.join(projectRoot, 'CLAUDE.md')) ? ['CLAUDE.md'] : []),
];

if (docFiles.length === 0) {
  err('docs/ и README.md не найдены');
  process.exit(1);
}

info(`Файлы: ${docFiles.join(', ')}`);

const indexed = new Set(db.getIndexedSources());
let newCount = 0;

for (const rel of docFiles) {
  if (indexed.has(rel)) {
    info(`⊙ ${rel} (cached)`);
    continue;
  }
  if (!existsSync(path.join(projectRoot, rel))) continue;

  const spinStop = startSpinner(`${rel} — embedding...`);
  const content = readFileSync(path.join(projectRoot, rel), 'utf8');
  const chunks = chunkStructural(content, rel);
  const texts = chunks.map(ch => truncateToTokens(ch.content));
  const embeddings = await embProvider.embed(texts);
  const now = Date.now();

  db.insertChunks(chunks.map((ch, i) => ({
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
  })));

  spinStop();
  ok(`${rel} (${chunks.length} chunks)`);
  newCount++;
}

const stats = db.getChunkStats('structural');
ok(`Индекс готов: ${stats.count} чанков`);
if (newCount === 0) info('(все файлы были закэшированы)');

// ── 4. Семантический поиск по тикету ──────────────────────────────────────

header('4. Семантический поиск');

const searchQuery = `${ticket.title}\n${ticket.description ?? ''}`;
stopSpin = startSpinner('Ищу релевантные чанки...');
const [queryEmb] = await embProvider.embed([searchQuery]);
const results = db.search(new Float32Array(queryEmb), TOP_K, 'structural', undefined, MIN_SCORE);
stopSpin();

if (results.length === 0) {
  err(`Релевантных чанков не найдено (minScore=${MIN_SCORE})`);
  process.exit(1);
}

ok(`Найдено чанков: ${results.length}`);
for (const r of results) {
  info(`  [${r.score.toFixed(3)}] ${r.source}`);
}

// ── 5. DeepSeek — генерация ответа ────────────────────────────────────────

header('5. AI Ответ — DeepSeek');

const context = results
  .map((r, i) => `--- [${i + 1}] ${r.source} (score: ${r.score.toFixed(3)}) ---\n${r.content}`)
  .join('\n\n');

const ticketContext = [
  `Тикет: [${ticket.id}] ${ticket.title}`,
  `Приоритет: ${PRIORITY_LABEL[ticket.priority] ?? ticket.priority}`,
  `Статус: ${ticket.state.name}`,
  ticket.description ? `\nОписание проблемы:\n${ticket.description}` : '',
].filter(Boolean).join('\n');

const messages: Message[] = [
  { role: 'system', content: SYSTEM_PROMPT },
  {
    role: 'user',
    content: `## Контекст тикета\n${ticketContext}\n\n## Документация\n${context}\n\n---\n\nДай ответ на проблему из тикета, используя документацию выше.`,
  },
];

let response = '';
let firstToken = true;
stopSpin = startSpinner('Генерирую ответ...');

for await (const chunk of deepseek.stream(messages, { temperature: 0.2 })) {
  if (chunk.type === 'text') {
    if (firstToken) {
      stopSpin();
      process.stdout.write('\n');
      firstToken = false;
    }
    process.stdout.write(`${c.green}${chunk.text}${c.reset}`);
    response += chunk.text;
  }
}
if (firstToken) stopSpin();
console.log('\n');

if (!response) {
  err('Ответ не сгенерирован');
  process.exit(1);
}

// ── 6. Linear — обновить тикет с ответом ──────────────────────────────────

header('6. Linear CRM — обновление тикета');

const updatedDescription = [
  ticket.description ?? '',
  '',
  '---',
  '## Ответ поддержки (AI)',
  '',
  response,
].join('\n');

stopSpin = startSpinner('Обновляю тикет...');
const updated = await updateIssue(LINEAR_KEY, ticket.id, updatedDescription);
stopSpin();

ok(`Тикет обновлён: [${updated.id}] ${updated.title}`);
console.log(`\n  ${c.bold}${c.cyan}${updated.url}${c.reset}\n`);

// ── Done ───────────────────────────────────────────────────────────────────

console.log(`${c.green}${c.bold}✓ Демонстрация завершена${c.reset}`);
console.log(`  ${c.dim}Тикет обновлён с ответом поддержки: ${updated.url}${c.reset}\n`);
