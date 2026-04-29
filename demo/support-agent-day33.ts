#!/usr/bin/env tsx
/**
 * День 33 — Support Agent (polling loop)
 *
 * Протокол через Linear comments:
 *   Новый тикет (unstarted, 0 комментариев) → In Progress + comment role:support
 *   Тикет (started, последний comment role:user)     → новый comment role:support
 *   Тикет (started, последний comment role:resolved) → Done
 *
 * Usage:
 *   npm run demo:day33:support
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
import {
  getViewer, getFirstTeam, getWorkflowStates, listIssues, getIssue, updateIssue,
  listComments, createComment, getCommentAuthor, RESOLVED_MARKER,
  sleep,
} from './lib/linear.js';

// ── Config ─────────────────────────────────────────────────────────────────

const POLL_MS = 5_000;
const TOP_K = 5;
const MIN_SCORE = 0.25;
const IS_TTY = process.stdout.isTTY;

const SYSTEM_PROMPT = `Ты — ассистент поддержки пользователей продукта CLI Agent.
Отвечай строго на основе предоставленной документации.
Учитывай всю историю переписки (предыдущие комментарии).
Давай конкретные пошаговые инструкции. Пиши на русском языке.
Если ответ не в документации — скажи об этом честно.`;

// ── Colors ─────────────────────────────────────────────────────────────────

const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', cyan: '\x1b[36m', blue: '\x1b[34m', red: '\x1b[31m',
};

const P = `${c.blue}${c.bold}[SUPPORT]${c.reset}`;
function log(msg: string) { console.log(`${P} ${msg}`); }
function ok(msg: string)  { console.log(`${P} ${c.green}✓${c.reset} ${msg}`); }
function err(msg: string) { console.log(`${P} ${c.red}✗${c.reset} ${msg}`); }
function dim(msg: string) { console.log(`${P} ${c.dim}${msg}${c.reset}`); }

function spinner(label: string): () => void {
  if (!IS_TTY) { dim(`⟳ ${label}`); return () => {}; }
  const frames = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
  let i = 0;
  const t = setInterval(() => process.stdout.write(`\r${P} ${c.cyan}${frames[i++ % frames.length]}${c.reset} ${label}`), 80);
  return () => { clearInterval(t); process.stdout.write('\r\x1b[K'); };
}

// ── Setup ──────────────────────────────────────────────────────────────────

const projectRoot = process.cwd();
const secrets = loadSecrets();
const config = loadProjectConfig(projectRoot);

const LINEAR_KEY = process.env.LINEAR_API_KEY ?? secrets.linear?.apiKey ?? '';
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY ?? secrets.deepseek?.apiKey ?? '';

if (!LINEAR_KEY) { err('LINEAR_API_KEY не найден'); process.exit(1); }
if (!DEEPSEEK_KEY) { err('DEEPSEEK_API_KEY не найден'); process.exit(1); }

const deepseek = new DeepSeekProvider(DEEPSEEK_KEY, 'deepseek-chat');

const e = config.embeddingProvider;
const embProvider = createEmbeddingProvider({
  type: e?.type ?? 'ollama', model: e?.model ?? 'nomic-embed-text',
  url: e?.url, apiKey: e?.apiKey,
} as EmbeddingConfig);

const db = new SearchDB(path.join(projectRoot, '.agent', 'data', 'search.db'));

// ── RAG ────────────────────────────────────────────────────────────────────

function walkMd(dir: string, base: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walkMd(full, base));
    else if (name.endsWith('.md')) out.push(path.relative(base, full));
  }
  return out;
}

async function indexDocs(): Promise<void> {
  const files = [
    ...walkMd(path.join(projectRoot, 'docs'), projectRoot),
    ...(existsSync(path.join(projectRoot, 'README.md')) ? ['README.md'] : []),
    ...(existsSync(path.join(projectRoot, 'CLAUDE.md')) ? ['CLAUDE.md'] : []),
  ];
  const indexed = new Set(db.getIndexedSources());
  let newCount = 0;
  for (const rel of files) {
    if (indexed.has(rel) || !existsSync(path.join(projectRoot, rel))) continue;
    const stop = spinner(`Индексирую ${rel}...`);
    const content = readFileSync(path.join(projectRoot, rel), 'utf8');
    const chunks = chunkStructural(content, rel);
    const embeddings = await embProvider.embed(chunks.map(ch => truncateToTokens(ch.content)));
    const now = Date.now();
    db.insertChunks(chunks.map((ch, i) => ({
      id: `${rel}:structural:${ch.chunkIndex}`,
      source: rel, title: path.basename(rel), section: ch.section,
      strategy: 'structural' as const, chunk_index: ch.chunkIndex,
      content: ch.content, token_count: ch.tokenCount,
      embedding: Buffer.from(new Float32Array(embeddings[i]).buffer),
      indexed_at: now,
    })));
    stop();
    ok(`${rel} (${chunks.length} chunks)`);
    newCount++;
  }
  const stats = db.getChunkStats('structural');
  log(`Индекс: ${stats.count} чанков${newCount === 0 ? ' (все кэшированы)' : ''}`);
}

async function ragSearch(query: string) {
  const [emb] = await embProvider.embed([query]);
  return db.search(new Float32Array(emb), TOP_K, 'structural', undefined, MIN_SCORE);
}

// ── Answer generation ──────────────────────────────────────────────────────

async function generateAnswer(title: string, context: string, searchQuery?: string): Promise<string> {
  const stop = spinner('Ищу в документации...');
  // Embed only a short query — Ollama has token limits
  const query = (searchQuery ?? `${title}\n${context}`).slice(0, 600);
  const results = await ragSearch(query);
  stop();

  if (results.length === 0) {
    return 'К сожалению, в документации не найдено информации по данной проблеме. Пожалуйста, уточните детали или обратитесь к maintainer проекта.';
  }

  dim(`Найдено чанков: ${results.length}`);
  for (const r of results) dim(`  [${r.score.toFixed(3)}] ${r.source}`);

  const docs = results.map((r, i) => `--- [${i + 1}] ${r.source} ---\n${r.content}`).join('\n\n');

  const messages: Message[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `## Тикет: ${title}\n\n## История / вопрос\n${context}\n\n## Документация\n${docs}\n\n---\nДай ответ на вопрос пользователя.`,
    },
  ];

  const stop2 = spinner('Генерирую ответ...');
  let answer = '';
  let first = true;
  for await (const chunk of deepseek.stream(messages, { temperature: 0.2 })) {
    if (chunk.type === 'text') {
      if (first) { stop2(); if (IS_TTY) process.stdout.write('\n'); first = false; }
      if (IS_TTY) process.stdout.write(`${c.green}${chunk.text}${c.reset}`);
      answer += chunk.text;
    }
  }
  if (first) stop2();
  if (IS_TTY) console.log('\n');
  else dim(`Ответ сгенерирован (${answer.length} символов)`);
  return answer;
}

// ── Ticket handler ─────────────────────────────────────────────────────────

const inProgress = new Set<string>();
const cooldown = new Map<string, number>();

let SUPPORT_USER_ID = '';

async function handleTicket(
  issueId: string,
  stateType: string,
  startedId: string,
  doneId: string,
): Promise<void> {
  if (inProgress.has(issueId)) return;
  const retryAfter = cooldown.get(issueId);
  if (retryAfter && Date.now() < retryAfter) return;

  inProgress.add(issueId);

  try {
    const comments = await listComments(LINEAR_KEY, issueId);
    const last = comments.at(-1);
    const lastAuthor = last ? getCommentAuthor(last, SUPPORT_USER_ID) : null;

    // New ticket: no comments yet → pick up
    if ((stateType === 'unstarted' || stateType === 'backlog') && comments.length === 0) {
      const issue = await getIssue(LINEAR_KEY, issueId);
      log(`📥 Новый тикет: [${issue.id}] ${issue.title}`);
      await updateIssue(LINEAR_KEY, issueId, { stateId: startedId });
      ok('Статус → In Progress');
      const answer = await generateAnswer(issue.title, issue.description ?? issue.title);
      await createComment(LINEAR_KEY, issueId, answer);
      ok(`Ответ опубликован → ${issue.url}`);
      return;
    }

    // User asked follow-up
    if (stateType === 'started' && lastAuthor === 'user') {
      const issue = await getIssue(LINEAR_KEY, issueId);
      log(`💬 Уточнение от пользователя: [${issue.id}] ${issue.title}`);
      const lastUserText = last!.body.trim();
      const history = comments
        .map(cm => {
          const who = cm.user?.id === SUPPORT_USER_ID ? 'Поддержка' : cm.user?.name ?? 'Пользователь';
          return `**${who}:** ${cm.body.trim()}`;
        })
        .join('\n\n---\n\n');
      const answer = await generateAnswer(
        issue.title,
        `${issue.description ?? ''}\n\n## История диалога\n${history}`,
        `${issue.title} ${lastUserText}`,
      );
      await createComment(LINEAR_KEY, issueId, answer);
      ok(`Ответ опубликован → ${issue.url}`);
      return;
    }

    // User confirmed resolution
    if (stateType === 'started' && lastAuthor === 'resolved') {
      const issue = await getIssue(LINEAR_KEY, issueId);
      log(`✅ Тикет решён: [${issue.id}] ${issue.title}`);
      await updateIssue(LINEAR_KEY, issueId, { stateId: doneId });
      ok(`Статус → Done → ${issue.url}`);
      return;
    }

  } catch (e: any) {
    err(`Ошибка обработки тикета ${issueId.slice(0, 8)}: ${e.message}`);
    cooldown.set(issueId, Date.now() + 30_000);
  } finally {
    inProgress.delete(issueId);
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

console.log('');
console.log(`${c.blue}${c.bold}╔══════════════════════════════════════════╗${c.reset}`);
console.log(`${c.blue}${c.bold}║  Support Agent — День 33  (ctrl+c стоп)  ║${c.reset}`);
console.log(`${c.blue}${c.bold}╚══════════════════════════════════════════╝${c.reset}`);
console.log('');

ok('LINEAR_API_KEY ✓');
ok('DEEPSEEK_API_KEY ✓');

log('Индексирую документацию...');
await indexDocs();

const viewer = await getViewer(LINEAR_KEY);
SUPPORT_USER_ID = viewer.id;
log(`Аккаунт поддержки: ${viewer.name} (${viewer.id.slice(0, 8)}...)`);

const team = await getFirstTeam(LINEAR_KEY);
log(`Команда: ${team.name}`);

const states = await getWorkflowStates(LINEAR_KEY, team.id);
const startedState = states.find(s => s.type === 'started');
const doneState    = states.find(s => s.type === 'completed');

if (!startedState) { err('Не найден статус типа "started"');   process.exit(1); }
if (!doneState)    { err('Не найден статус типа "completed"'); process.exit(1); }

log(`In Progress: "${startedState.name}" | Done: "${doneState.name}"`);
log(`Опрос каждые ${POLL_MS / 1000}с... Жду тикеты.\n`);

while (true) {
  try {
    const issues = await listIssues(LINEAR_KEY, { teamId: team.id, limit: 20 });
    const active = issues.filter(i => i.state.type !== 'completed' && i.state.type !== 'cancelled');
    for (const issue of active) {
      await handleTicket(issue.id, issue.state.type, startedState.id, doneState.id).catch((e: any) => {
        err(`Ошибка обработки тикета: ${e.message}`);
      });
    }
  } catch (e: any) {
    err(`Ошибка опроса Linear: ${e.message}`);
  }
  await sleep(POLL_MS);
}
