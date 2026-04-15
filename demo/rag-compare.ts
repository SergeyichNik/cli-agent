#!/usr/bin/env tsx
/**
 * RAG Demo — День 23
 *
 * Требует предварительной индексации: npm run demo:index
 *
 * Usage:
 *   tsx demo/rag-compare.ts --mode rag         "Кто CEO ОсьминогСофт?"
 *   tsx demo/rag-compare.ts --mode rag-rerank  "Кто CEO ОсьминогСофт?"
 *   tsx demo/rag-compare.ts --mode rag          # автопрогон всех вопросов
 *
 * npm scripts:
 *   npm run demo:rag         -- "вопрос"
 *   npm run demo:rag-rerank  -- "вопрос"
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

const TOP_K_RAG     = 8;   // RAG без фильтра: шумный контекст из нескольких компаний
const TOP_K_BEFORE  = 15;  // RAG+rerank: кандидаты до фильтрации
const TOP_K_AFTER   = 3;   // RAG+rerank: финальный контекст после фильтрации
const MIN_SCORE     = 0.50; // порог отсечения

// ---------------------------------------------------------------------------
// Parse CLI args
// ---------------------------------------------------------------------------

const rawArgs = process.argv.slice(2);
const modeIdx = rawArgs.indexOf('--mode');

if (modeIdx === -1 || !rawArgs[modeIdx + 1]) {
  console.error('Usage: tsx demo/rag-compare.ts --mode <rag|rag-rerank> ["<question>"]');
  process.exit(1);
}

const mode = rawArgs[modeIdx + 1];
if (mode !== 'rag' && mode !== 'rag-rerank') {
  console.error('Error: --mode must be "rag" or "rag-rerank"');
  process.exit(1);
}

const questionParts = rawArgs.filter((_, i) => i !== modeIdx && i !== modeIdx + 1);
const singleQuestion = questionParts.join(' ').trim();

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
// Stream LLM response
// ---------------------------------------------------------------------------

async function streamAnswer(messages: Message[]): Promise<void> {
  for await (const chunk of llm.stream(messages, { temperature: 0.3 })) {
    if (chunk.type === 'text') process.stdout.write(chunk.text);
  }
  process.stdout.write('\n');
}

// ---------------------------------------------------------------------------
// Обработка одного вопроса
// ---------------------------------------------------------------------------

const divider = '─'.repeat(60);
const label = mode === 'rag' ? '[ RAG ]' : '[ RAG + RERANK ]';

async function runQuestion(question: string, idx?: number, total?: number): Promise<void> {
  const header = idx !== undefined ? `[${idx}/${total}] ` : '';
  console.log(`\n${divider}`);
  console.log(`${label}  ${header}${question}`);
  console.log(divider);

  const [queryEmbedding] = await embProvider.embed([question]);

  if (mode === 'rag') {
    // Без фильтра: берём TOP_K_RAG чанков — в контексте окажутся все компании
    const results = db.search(new Float32Array(queryEmbedding), TOP_K_RAG);
    const scores = results.map(r => `${r.source} ${r.score.toFixed(3)}`).join('\n  ');
    console.log(`Чанков в контексте: ${results.length}`);
    console.log(`  ${scores}\n`);
    const context = results.map(r => `[${r.source}]\n${r.content}`).join('\n---\n');
    const prompt = `Используй только следующий контекст для ответа на вопрос.\n\nКонтекст:\n\n${context}\n\nВопрос: ${question}`;
    await streamAnswer([{ role: 'user', content: prompt }]);
  } else {
    // С фильтром: берём TOP_K_BEFORE кандидатов, отсекаем нерелевантные
    const allResults = db.search(new Float32Array(queryEmbedding), TOP_K_BEFORE);
    const filtered = allResults.filter(r => r.score >= MIN_SCORE).slice(0, TOP_K_AFTER);
    const allScores = allResults.map(r => `${r.source} ${r.score.toFixed(3)}`).join('\n  ');
    console.log(`Кандидатов: ${allResults.length}`);
    console.log(`  ${allScores}`);
    console.log(`После фильтра (≥${MIN_SCORE}): ${filtered.length} чанков\n`);
    if (filtered.length === 0) {
      console.log('Нет чанков выше порога — нет контекста для ответа.');
    } else {
      const context = filtered.map(r => `[${r.source}]\n${r.content}`).join('\n---\n');
      const prompt = `Используй только следующий контекст для ответа на вопрос.\n\nКонтекст:\n\n${context}\n\nВопрос: ${question}`;
      await streamAnswer([{ role: 'user', content: prompt }]);
    }
  }
  console.log(divider);
}

// ---------------------------------------------------------------------------
// Один вопрос или автопрогон
// ---------------------------------------------------------------------------

if (singleQuestion) {
  await runQuestion(singleQuestion);
} else {
  console.log(`\n${divider}`);
  console.log(`${label}  АВТОПРОГОН — ${ALL_QUESTIONS.length} вопросов`);
  console.log(divider);
  for (let i = 0; i < ALL_QUESTIONS.length; i++) {
    await runQuestion(ALL_QUESTIONS[i], i + 1, ALL_QUESTIONS.length);
  }
  console.log(`\nГотово.`);
}
