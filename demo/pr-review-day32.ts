#!/usr/bin/env tsx
/**
 * День 32 — Автоматизация ревью кода
 *
 * Демонстрирует пайплайн AI-ревью PR:
 *   1. GitHub API — получение diff и списка файлов
 *   2. RAG         — чтение содержимого изменённых файлов (без embeddings)
 *   3. DeepSeek    — генерация структурированного ревью
 *   4. GitHub API  — публикация комментария к PR
 *
 * Требует:
 *   - GITHUB_TOKEN в env или ~/.config/agent/secrets.json (github.token)
 *   - DEEPSEEK_API_KEY в env или ~/.config/agent/secrets.json
 *
 * Usage:
 *   npm run demo:day32
 *   npm run demo:day32 -- --repo owner/repo --pr 42
 */

import path from 'path';
import { existsSync, readFileSync } from 'fs';
import { loadSecrets } from '../src/agent/secrets.js';
import { DeepSeekProvider } from '../src/providers/deepseek.js';
import type { Message } from '../src/providers/base.js';

// ── Config ─────────────────────────────────────────────────────────────────

const DEFAULT_REPO = 'SergeyichNik/cli-agent';
const BASE_URL = 'https://api.github.com';
const MAX_DIFF_CHARS = 8000;
const MAX_FILE_CHARS = 3000;

// ── Args ───────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const repoIdx = argv.indexOf('--repo');
const prIdx   = argv.indexOf('--pr');
const REPO    = repoIdx !== -1 ? argv[repoIdx + 1] : DEFAULT_REPO;
const PR_STR  = prIdx   !== -1 ? argv[prIdx + 1]   : undefined;

if (!REPO.includes('/')) {
  console.error('Usage: npm run demo:day32 -- --repo owner/repo --pr <number>');
  process.exit(1);
}

const [OWNER, REPO_NAME] = REPO.split('/');

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
  magenta: '\x1b[35m',
  red:     '\x1b[31m',
};

function header(text: string) {
  console.log(`\n${c.bold}━━━ ${text} ━━━${c.reset}`);
}

function ok(msg: string)   { console.log(`  ${c.green}✓${c.reset} ${msg}`); }
function info(msg: string) { console.log(`  ${c.dim}${msg}${c.reset}`); }
function err(msg: string)  { console.log(`  ${c.red}✗${c.reset} ${msg}`); }

// ── GitHub helpers ─────────────────────────────────────────────────────────

interface PrInfo  { number: number; title: string; head: { ref: string }; base: { ref: string } }
interface PrFile  { filename: string; status: string; additions: number; deletions: number; patch?: string }

async function ghGet(urlPath: string, token: string, accept = 'application/vnd.github+json'): Promise<Response> {
  return fetch(`${BASE_URL}${urlPath}`, {
    headers: {
      Accept: accept,
      'X-GitHub-Api-Version': '2022-11-28',
      Authorization: `Bearer ${token}`,
    },
  });
}

async function ghPost(urlPath: string, token: string, body: unknown): Promise<Response> {
  return fetch(`${BASE_URL}${urlPath}`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

// ── Spinner ────────────────────────────────────────────────────────────────

function startSpinner(label: string): () => void {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const t = setInterval(() => {
    process.stdout.write(`\r  ${c.cyan}${frames[i++ % frames.length]}${c.reset} ${label}`);
  }, 80);
  return () => { clearInterval(t); process.stdout.write('\r\x1b[K'); };
}

// ── System prompt ──────────────────────────────────────────────────────────

const REVIEW_SYSTEM_PROMPT = `Ты — опытный инженер, проводящий код-ревью Pull Request.
Проанализируй предоставленный diff и содержимое изменённых файлов.

Верни ревью строго в следующем Markdown-формате:

## AI Code Review {VERDICT}

### 🐛 Потенциальные баги
{список багов или "_Не обнаружено._"}

### 🏗️ Архитектурные проблемы
{список проблем или "_Не обнаружено._"}

### 💡 Рекомендации
{список рекомендаций или "_Нет дополнительных рекомендаций._"}

---
*Автоматическое ревью сгенерировано AI (DeepSeek) на основе diff и содержимого файлов.*

Правила:
- VERDICT = "✅ Выглядит хорошо" если серьёзных замечаний нет
- VERDICT = "⚠️ Есть замечания (N)" где N — суммарное количество пунктов в первых двух секциях
- Каждая секция ОБЯЗАНА присутствовать — если замечаний нет, пиши "_Не обнаружено._"
- Пиши по-русски, конкретно и по делу`;

// ── Main ───────────────────────────────────────────────────────────────────

console.log('');
console.log(`${c.bold}╔══════════════════════════════════════════════╗${c.reset}`);
console.log(`${c.bold}║   День 32 — Автоматизация ревью кода         ║${c.reset}`);
console.log(`${c.bold}╚══════════════════════════════════════════════╝${c.reset}`);

// ── Credentials ────────────────────────────────────────────────────────────

header('0. Credentials');

const secrets = loadSecrets();
const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? secrets.github?.apiKey ?? '';
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY ?? secrets.deepseek?.apiKey ?? '';

if (!GITHUB_TOKEN) {
  err('GITHUB_TOKEN не найден');
  info('Добавьте в env или ~/.config/agent/secrets.json → github.token');
  process.exit(1);
}
if (!DEEPSEEK_KEY) {
  err('DEEPSEEK_API_KEY не найден');
  info('Добавьте в env или ~/.config/agent/secrets.json → deepseek.apiKey');
  process.exit(1);
}
ok('GITHUB_TOKEN  ✓');
ok('DEEPSEEK_API_KEY  ✓');

// ── 1. Pick PR ─────────────────────────────────────────────────────────────

header(`1. GitHub PR — ${REPO}`);

let prNumber: number;

if (PR_STR) {
  prNumber = parseInt(PR_STR, 10);
  if (isNaN(prNumber) || prNumber <= 0) {
    err(`Неверный номер PR: ${PR_STR}`);
    process.exit(1);
  }
  info(`PR задан аргументом: #${prNumber}`);
} else {
  // Auto-pick the latest open PR
  const stopSpin = startSpinner('Получаю список открытых PR...');
  const listRes = await ghGet(`/repos/${OWNER}/${REPO_NAME}/pulls?state=open&per_page=5`, GITHUB_TOKEN);
  stopSpin();
  if (!listRes.ok) {
    err(`GitHub error ${listRes.status}`);
    process.exit(1);
  }
  const prs = await listRes.json() as PrInfo[];
  if (prs.length === 0) {
    err('Открытых PR не найдено. Передайте --pr <number> явно.');
    process.exit(1);
  }
  prNumber = prs[0].number;
  info(`Открытых PR: ${prs.length}`);
  for (const pr of prs) {
    info(`  #${pr.number}  ${pr.head.ref} → ${pr.base.ref}  "${pr.title}"`);
  }
  ok(`Выбран последний: #${prNumber}`);
}

// ── 2. Fetch diff ──────────────────────────────────────────────────────────

header('2. Diff');

let stopSpin = startSpinner('Загружаю diff...');
const diffRes = await ghGet(
  `/repos/${OWNER}/${REPO_NAME}/pulls/${prNumber}`,
  GITHUB_TOKEN,
  'application/vnd.github.diff',
);
stopSpin();

if (!diffRes.ok) {
  err(`GitHub error ${diffRes.status}: ${await diffRes.text()}`);
  process.exit(1);
}
const diff = await diffRes.text();
const diffLines = diff.split('\n');
ok(`Diff получен: ${diffLines.length} строк`);

// Show first few diff lines as preview
const previewLines = diffLines.slice(0, 12).filter(l => l.trim());
for (const line of previewLines) {
  const color = line.startsWith('+') ? c.green : line.startsWith('-') ? c.red : c.dim;
  info(`  ${color}${line.slice(0, 80)}${c.reset}`);
}
if (diffLines.length > 12) info(`  ... и ещё ${diffLines.length - 12} строк`);

// ── 3. Changed files ───────────────────────────────────────────────────────

header('3. Изменённые файлы');

stopSpin = startSpinner('Загружаю список файлов...');
const filesRes = await ghGet(`/repos/${OWNER}/${REPO_NAME}/pulls/${prNumber}/files`, GITHUB_TOKEN);
stopSpin();

if (!filesRes.ok) {
  err(`GitHub error ${filesRes.status}`);
  process.exit(1);
}
const changedFiles = await filesRes.json() as PrFile[];
ok(`Файлов изменено: ${changedFiles.length}`);

for (const f of changedFiles) {
  const icon = f.status === 'added' ? `${c.green}+${c.reset}` : f.status === 'removed' ? `${c.red}-${c.reset}` : `${c.yellow}~${c.reset}`;
  console.log(`    ${icon} ${f.filename}  ${c.dim}(+${f.additions}/-${f.deletions})${c.reset}`);
}

// ── 4. Read local files (RAG без embeddings) ───────────────────────────────

header('4. Чтение локальных файлов (RAG)');

const projectRoot = process.cwd();
const fileContents: string[] = [];
const readableFiles = changedFiles.filter(f => f.status !== 'removed');

for (const f of readableFiles) {
  const fullPath = path.join(projectRoot, f.filename);
  if (existsSync(fullPath)) {
    try {
      const content = readFileSync(fullPath, 'utf-8');
      fileContents.push(`--- ${f.filename} ---\n${content.slice(0, MAX_FILE_CHARS)}`);
      ok(`${f.filename}  ${c.dim}(${content.length} chars)${c.reset}`);
    } catch {
      info(`${f.filename}  (не удалось прочитать)`);
    }
  } else {
    info(`${f.filename}  (нет локально)`);
  }
}

info(`Загружено файлов: ${fileContents.length}/${readableFiles.length}`);

// ── 5. Generate review ─────────────────────────────────────────────────────

header('5. AI Ревью — DeepSeek');

const contextParts: string[] = [
  `## Diff PR #${prNumber} (${REPO})\n\`\`\`diff\n${diff.slice(0, MAX_DIFF_CHARS)}\n\`\`\``,
];
if (fileContents.length > 0) {
  contextParts.push(`## Содержимое изменённых файлов\n${fileContents.join('\n\n')}`);
}

const messages: Message[] = [
  { role: 'system', content: REVIEW_SYSTEM_PROMPT },
  { role: 'user', content: contextParts.join('\n\n') + '\n\nПроведи ревью этого PR.' },
];

const deepseek = new DeepSeekProvider(DEEPSEEK_KEY, 'deepseek-chat');
let reviewText = '';

stopSpin = startSpinner('Генерирую ревью...');
let firstToken = true;

for await (const chunk of deepseek.stream(messages, { temperature: 0.1 })) {
  if (chunk.type === 'text') {
    if (firstToken) {
      stopSpin();
      process.stdout.write('\n');
      firstToken = false;
    }
    process.stdout.write(chunk.text);
    reviewText += chunk.text;
  }
}
if (firstToken) stopSpin();
console.log('\n');

if (!reviewText) {
  err('Ревью не сгенерировано');
  process.exit(1);
}

// ── 6. Post comment ────────────────────────────────────────────────────────

header('6. Публикация комментария');

stopSpin = startSpinner('Публикую комментарий к PR...');
const postRes = await ghPost(
  `/repos/${OWNER}/${REPO_NAME}/issues/${prNumber}/comments`,
  GITHUB_TOKEN,
  { body: reviewText },
);
stopSpin();

if (!postRes.ok) {
  const body = await postRes.text();
  err(`GitHub error ${postRes.status}: ${body}`);
  info('Ревью выведено выше — можно скопировать вручную');
} else {
  const result = await postRes.json() as { html_url: string; id: number };
  ok(`Комментарий опубликован (id: ${result.id})`);
  console.log(`\n  ${c.bold}${c.cyan}${result.html_url}${c.reset}\n`);
}

// ── Done ───────────────────────────────────────────────────────────────────

console.log(`${c.green}${c.bold}✓ Демонстрация завершена${c.reset}`);
console.log(`  ${c.dim}CLI: agent review-pr --repo ${REPO} --pr ${prNumber}${c.reset}\n`);
