#!/usr/bin/env tsx
/**
 * RAG Demo — День 28: Локальная LLM + RAG
 *
 * Retrieval через локальный индекс, генерация через LM Studio (локально) и DeepSeek (облако).
 * Требует предварительной индексации: npm run demo:index
 * Требует запущенного Ollama с mxbai-embed-large для эмбеддингов.
 *
 * Usage:
 *   tsx demo/rag-day28.ts "Кто CEO ОсьминогСофт?"
 *   tsx demo/rag-day28.ts                           # автопрогон
 *
 * npm scripts:
 *   npm run demo:day28 -- "вопрос"
 */

import path from 'path';
import * as clack from '@clack/prompts';
import { SearchDB } from '../mcp-servers/search/db.js';
import { createProvider as createEmbeddingProvider, type EmbeddingConfig } from '../mcp-servers/search/embeddings.js';
import { loadProjectConfig } from '../src/agent/config.js';
import { loadSecrets } from '../src/agent/secrets.js';
import { LMStudioProvider } from '../src/providers/lmstudio.js';
import type { Message } from '../src/providers/base.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TOP_K = 5;
const MIN_SCORE = 0.45;

const LMSTUDIO_MODEL = 'qwen2.5-coder-14b-instruct-mlx';

// ---------------------------------------------------------------------------
// ANSI colors
// ---------------------------------------------------------------------------

const c = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  gray:   '\x1b[90m',
  white:  '\x1b[97m',
};

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `Ты — ассистент, отвечающий строго по предоставленному контексту.
Если в контексте есть ответ — отвечай кратко и по делу.
Если контекст не содержит ответа — напиши "Не знаю." и попроси уточнить вопрос.
Никогда не придумывай факты сверх того, что есть в контексте.`;

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const rawArgs = process.argv.slice(2);
const singleQuestion = rawArgs.join(' ').trim();

const ALL_QUESTIONS = [
  'Что такое КальмарКоин и как он используется для зарплаты?',
  'Как работает телепатический компилятор в ОсьминогСофт?',
  'Кто такой Геннадий Щупальцев?',
  'Что поют сотрудники ПингвинТех на каждом деплое?',
  'Какой курс доллара к рублю на сегодня?',
];

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const projectRoot = process.cwd();
const dbPath = path.join(projectRoot, '.agent', 'data', 'search.db');

const config = loadProjectConfig(projectRoot);
const secrets = loadSecrets();

const lmStudioUrl = secrets.lmstudio?.baseUrl ?? process.env.LMSTUDIO_BASE_URL ?? 'http://localhost:1234/v1';

const lmStudio = new LMStudioProvider(LMSTUDIO_MODEL, lmStudioUrl);

const e = config.embeddingProvider;
const embProvider = createEmbeddingProvider({
  type: e?.type ?? 'ollama', model: e?.model, url: e?.url, apiKey: e?.apiKey,
} as EmbeddingConfig);

const db = new SearchDB(dbPath);

if (db.getIndexedSources().length === 0) {
  clack.log.error('Индекс пуст. Сначала запусти: npm run demo:index');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Stream LLM response — spinner until first token, then raw stream
// ---------------------------------------------------------------------------

async function streamAnswer(messages: Message[]): Promise<{ ms: number }> {
  const start = Date.now();
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let frameIdx = 0;
  const spinInterval = setInterval(() => {
    process.stdout.write(`\r${c.cyan}${frames[frameIdx++ % frames.length]}${c.reset} Генерирую ответ...`);
  }, 80);

  let firstToken = true;
  for await (const chunk of lmStudio.stream(messages, { temperature: 0.3 })) {
    if (chunk.type === 'text') {
      if (firstToken) {
        clearInterval(spinInterval);
        process.stdout.write('\r\x1b[K\n');
        firstToken = false;
      }
      process.stdout.write(chunk.text);
    }
  }

  if (firstToken) {
    clearInterval(spinInterval);
    process.stdout.write('\r\x1b[K');
  } else {
    process.stdout.write('\n');
  }

  return { ms: Date.now() - start };
}

// ---------------------------------------------------------------------------
// Main: one question
// ---------------------------------------------------------------------------

async function runQuestion(question: string, idx?: number, total?: number): Promise<void> {
  const prefix = idx !== undefined ? `${c.gray}[${idx}/${total}]${c.reset} ` : '';
  console.log(`\n${c.bold}${c.cyan}?${c.reset} ${prefix}${c.white}${c.bold}${question}${c.reset}`);

  // Retrieval
  const retrievalStart = Date.now();
  const spin = clack.spinner();
  spin.start('Ищу в индексе...');
  const [queryEmbedding] = await embProvider.embed([question]);
  const results = db.search(new Float32Array(queryEmbedding), TOP_K + 10);
  const filtered = results.filter(r => r.score >= MIN_SCORE).slice(0, TOP_K);
  const retrievalMs = Date.now() - retrievalStart;
  spin.stop(`${c.bold}${filtered.length}${c.reset} чанков найдено за ${c.dim}${retrievalMs}ms${c.reset}`);

  if (filtered.length === 0) {
    clack.log.warn('Нет релевантного контекста — уточните вопрос.');
    return;
  }

  const context = filtered
    .map((r, i) => [
      `[${i + 1}] source: ${r.source}${r.section ? ` | section: ${r.section}` : ''}`,
      r.content,
    ].join('\n'))
    .join('\n\n---\n\n');

  const messages: Message[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Контекст:\n\n${context}\n\nВопрос: ${question}` },
  ];

  console.log(`\n${c.green}${c.bold}── LM Studio (${LMSTUDIO_MODEL}) ──${c.reset}`);
  const { ms } = await streamAnswer(messages);
  console.log(`${c.dim}⏱  ${ms}ms${c.reset}`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (singleQuestion) {
  clack.intro('День 28: Локальная LLM + RAG');
  await runQuestion(singleQuestion);
  clack.outro('Готово.');
} else {
  clack.intro(`День 28: Локальная LLM + RAG — автопрогон ${ALL_QUESTIONS.length} вопросов`);
  for (let i = 0; i < ALL_QUESTIONS.length; i++) {
    await runQuestion(ALL_QUESTIONS[i], i + 1, ALL_QUESTIONS.length);
  }
  clack.outro('Готово.');
}
