#!/usr/bin/env tsx
/**
 * RAG Demo — День 24: Цитаты, источники и анти-галлюцинации
 *
 * Требует предварительной индексации: npm run demo:index
 *
 * Usage:
 *   tsx demo/rag-compare.ts "Кто CEO ОсьминогСофт?"   # один вопрос
 *   tsx demo/rag-compare.ts                            # автопрогон 10 вопросов
 *
 * npm scripts:
 *   npm run demo:rag         -- "вопрос"
 */

import path from 'path';
import { SearchDB } from '../mcp-servers/search/db.js';
import { createProvider as createEmbeddingProvider, type EmbeddingConfig } from '../mcp-servers/search/embeddings.js';
import { loadProjectConfig } from '../src/agent/config.js';
import { loadSecrets } from '../src/agent/secrets.js';
import { DeepSeekProvider } from '../src/providers/deepseek.js';
import { LMStudioProvider } from '../src/providers/lmstudio.js';
import type { Message } from '../src/providers/base.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TOP_K_BEFORE = 15;  // кандидаты до фильтрации
const TOP_K_AFTER  = 5;   // финальный контекст после фильтрации
const MIN_SCORE    = 0.50; // порог отсечения

// ---------------------------------------------------------------------------
// Системный промпт: обязательные источники, цитаты, режим "не знаю"
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `Ты — ассистент, отвечающий строго по предоставленному контексту.

Правила:
1. Если в контексте есть ответ — отвечай по нему.
2. В тексте ответа ставь inline-ссылки [1], [2] и т.д. на использованные чанки.
3. После ответа ОБЯЗАТЕЛЬНО выведи раздел "Источники:" — пронумерованный список с точной цитатой из каждого использованного чанка.
4. Если контекст не содержит ответа на вопрос — напиши "Не знаю." и попроси уточнить вопрос.
5. Никогда не придумывай факты сверх того, что есть в контексте.

Формат ответа:
<ответ с inline-ссылками [N]>

Источники:
[N] <source> § <section> — "<точная цитата из чанка>"`;

// ---------------------------------------------------------------------------
// Parse CLI args
// ---------------------------------------------------------------------------

const rawArgs = process.argv.slice(2);
const singleQuestion = rawArgs.join(' ').trim();

// ---------------------------------------------------------------------------
// Вопросы для автопрогона
// ---------------------------------------------------------------------------

const ALL_QUESTIONS = [
  'Что такое КальмарКоин и как он используется для зарплаты?',
  'Как работает телепатический компилятор в ОсьминогСофт?',
  'Кто такой Геннадий Щупальцев?',
  'Что такое компот из антарктического криля?',
  'Как работает Brainfuck с патчем от 2031 года?',
  'Где работает белка-аналитик и что она делает?',
  'Что такое нейросеть на пчёлах и как она работает?',
  'Что поют сотрудники ПингвинТех на каждом деплое?',
  'Как добраться до Атлантиды на подводном трамвае?',
  'Кто такой Прокопий Берложников и почему ушёл?',
  'Какой курс доллара к рублю на сегодня?',
  'Как приготовить классический борщ?',
];

// ---------------------------------------------------------------------------
// Setup: config, secrets, LLM, embeddings, DB
// ---------------------------------------------------------------------------

const projectRoot = process.cwd();
const dbPath = path.join(projectRoot, '.agent', 'data', 'search.db');

const config = loadProjectConfig(projectRoot);
const secrets = loadSecrets();

const apiKey =
  secrets[config.provider]?.apiKey ??
  (config.provider === 'deepseek' ? process.env.DEEPSEEK_API_KEY : undefined);
const lmStudioUrl = secrets.lmstudio?.baseUrl ?? process.env.LMSTUDIO_BASE_URL ?? 'http://localhost:1234/v1';
const deepSeekUrl = secrets.deepseek?.baseUrl ?? process.env.DEEPSEEK_BASE_URL;

const llm =
  config.provider === 'deepseek'
    ? new DeepSeekProvider(apiKey ?? '', config.model, deepSeekUrl)
    : new LMStudioProvider(config.model, lmStudioUrl);

const e = config.embeddingProvider;
const embProvider = createEmbeddingProvider({
  type: e?.type ?? 'ollama', model: e?.model, url: e?.url, apiKey: e?.apiKey,
} as EmbeddingConfig);

const db = new SearchDB(dbPath);

if (db.getIndexedSources().length === 0) {
  console.error('Индекс пуст. Сначала запусти: npm run demo:index');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Stream LLM response with system prompt
// ---------------------------------------------------------------------------

async function streamAnswer(question: string, context: string): Promise<void> {
  const messages: Message[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Контекст:\n\n${context}\n\nВопрос: ${question}` },
  ];
  for await (const chunk of llm.stream(messages, { temperature: 0.3 })) {
    if (chunk.type === 'text') process.stdout.write(chunk.text);
  }
  process.stdout.write('\n');
}

// ---------------------------------------------------------------------------
// Обработка одного вопроса
// ---------------------------------------------------------------------------

const divider = '─'.repeat(60);

async function runQuestion(question: string, idx?: number, total?: number): Promise<void> {
  const header = idx !== undefined ? `[${idx}/${total}] ` : '';
  console.log(`\n${divider}`);
  console.log(`[ RAG + CITATIONS ]  ${header}${question}`);
  console.log(divider);

  const [queryEmbedding] = await embProvider.embed([question]);

  const allResults = db.search(new Float32Array(queryEmbedding), TOP_K_BEFORE);
  const filtered = allResults.filter(r => r.score >= MIN_SCORE).slice(0, TOP_K_AFTER);

  const topScores = allResults.slice(0, 5).map(r => `${r.source} ${r.score.toFixed(3)}`).join('\n  ');
  console.log(`Кандидатов: ${allResults.length}`);
  console.log(`  ${topScores}`);
  console.log(`После фильтра (≥${MIN_SCORE}): ${filtered.length} чанков\n`);

  // Уровень 1: нет чанков — не вызываем LLM
  if (filtered.length === 0) {
    console.log('Не знаю. Нет релевантного контекста — уточните вопрос.');
    console.log(divider);
    return;
  }

  // Формат контекста с метаданными для цитирования (score не передаётся LLM)
  const context = filtered
    .map((r, i) => [
      `[${i + 1}] source: ${r.source}${r.section ? ` | section: ${r.section}` : ''} | id: ${r.id}`,
      r.content,
    ].join('\n'))
    .join('\n\n---\n\n');

  // Уровень 2: LLM сам решает "не знаю" если контекст не содержит ответа
  await streamAnswer(question, context);
  console.log(divider);
}

// ---------------------------------------------------------------------------
// Один вопрос или автопрогон
// ---------------------------------------------------------------------------

if (singleQuestion) {
  await runQuestion(singleQuestion);
} else {
  console.log(`\n${divider}`);
  console.log(`[ RAG + CITATIONS ]  АВТОПРОГОН — ${ALL_QUESTIONS.length} вопросов`);
  console.log(divider);
  for (let i = 0; i < ALL_QUESTIONS.length; i++) {
    await runQuestion(ALL_QUESTIONS[i], i + 1, ALL_QUESTIONS.length);
  }
  console.log(`\nГотово.`);
}
