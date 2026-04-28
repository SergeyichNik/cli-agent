#!/usr/bin/env tsx
/**
 * RAG Benchmark — День 23
 *
 * Требует предварительной индексации: npm run demo:index
 *
 * Прогоняет все вопросы в режимах RAG и RAG+rerank, показывает контраст.
 *
 * Usage:
 *   npm run demo:benchmark           # оба режима
 *   npm run demo:benchmark:rag       # только RAG
 *   npm run demo:benchmark:rerank    # только RAG+rerank
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

const TOP_K_RAG    = 8;    // RAG без фильтра: шумный контекст из нескольких компаний
const TOP_K_BEFORE = 15;   // RAG+rerank: кандидаты до фильтрации
const TOP_K_AFTER  = 3;    // RAG+rerank: финальный контекст после фильтрации
const MIN_SCORE    = 0.7; // порог отсечения

// ---------------------------------------------------------------------------
// CLI args: --mode rag | rag-rerank | both (default: both)
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const modeIdx = args.indexOf('--mode');
const mode = (modeIdx !== -1 ? args[modeIdx + 1] : 'both') as 'rag' | 'rag-rerank' | 'both';
if (!['rag', 'rag-rerank', 'both'].includes(mode)) {
  console.error('Usage: tsx demo/rag-benchmark.ts [--mode rag|rag-rerank|both]');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Вопросы
// ---------------------------------------------------------------------------

const QUESTIONS = [
  'Что такое КальмарКоин и как он используется для зарплаты?',
  // 'Как работает телепатический компилятор в ОсьминогСофт?',
  // 'Кто такой Геннадий Щупальцев?',
  // 'Что такое компот из антарктического криля?',
  // 'Как работает Brainfuck с патчем от 2031 года?',
  // 'Где работает белка-аналитик и что она делает?',
  // 'Что такое нейросеть на пчёлах и как она работает?',
  // 'Что поют сотрудники ПингвинТех на каждом деплое?',
  "Почему Раскольников решил убить старуху-процентщицу?",
  "Как звали сестру Раскольникова?",
  "Кто был женихом Дуни?",
  "Как звали следователя, расследовавшего убийство?",
  "Кого кроме старухи убил Раскольников?",
  'Как добраться до Атлантиды на подводном трамвае?',
  'Кто такой Прокопий Берложников и почему ушёл?',
];

// ---------------------------------------------------------------------------
// Setup
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
// Ask helpers
// ---------------------------------------------------------------------------

async function streamRag(question: string, queryEmbedding: number[]): Promise<void> {
  const results = db.search(new Float32Array(queryEmbedding), TOP_K_RAG);
  const scores = results.map(r => `${path.basename(r.source)}:${r.score.toFixed(2)}`).join(', ');
  console.log(`   чанков в контексте: ${results.length} | ${scores}`);
  const context = results.map(r => `[${r.source}]\n${r.content}`).join('\n---\n');
  const prompt = `Используй только следующий контекст для ответа на вопрос.\n\nКонтекст:\n\n${context}\n\nВопрос: ${question}`;
  for await (const chunk of llm.stream([{ role: 'user', content: prompt } as Message], { temperature: 0.3 })) {
    if (chunk.type === 'text') process.stdout.write(chunk.text);
  }
  process.stdout.write('\n');
}

async function streamRagRerank(question: string, queryEmbedding: number[]): Promise<void> {
  const allResults = db.search(new Float32Array(queryEmbedding), TOP_K_BEFORE);
  const filtered = allResults.filter(r => r.score >= MIN_SCORE).slice(0, TOP_K_AFTER);
  const scores = allResults.slice(0, 5).map(r => `${path.basename(r.source)}:${r.score.toFixed(2)}`).join(', ');
  console.log(`   до фильтра: ${allResults.length} | ${scores}…`);
  console.log(`   после (≥${MIN_SCORE}): ${filtered.length} чанков`);

  if (filtered.length === 0) {
    console.log('   Нет чанков выше порога.');
    return;
  }

  const context = filtered.map(r => `[${r.source}]\n${r.content}`).join('\n---\n');
  const prompt = `Используй только следующий контекст для ответа на вопрос.\n\nКонтекст:\n\n${context}\n\nВопрос: ${question}`;
  for await (const chunk of llm.stream([{ role: 'user', content: prompt } as Message], { temperature: 0.3 })) {
    if (chunk.type === 'text') process.stdout.write(chunk.text);
  }
  process.stdout.write('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const divider = '═'.repeat(70);
const thin = '─'.repeat(70);
const modeLabel = mode === 'rag' ? 'RAG' : mode === 'rag-rerank' ? 'RAG+RERANK' : 'RAG vs RAG+RERANK';

console.log(`\n${divider}`);
console.log(` BENCHMARK [${modeLabel}] — 3 компании × ${QUESTIONS.length} вопросов`);
console.log(divider);

for (let i = 0; i < QUESTIONS.length; i++) {
  const question = QUESTIONS[i];

  console.log(`\n[${i + 1}/${QUESTIONS.length}] ${question}`);
  console.log(thin);

  const [queryEmbedding] = await embProvider.embed([question]);

  if (mode === 'rag' || mode === 'both') {
    if (mode === 'both') console.log('[ RAG — без фильтра ]');
    await streamRag(question, queryEmbedding);
  }

  if (mode === 'rag-rerank' || mode === 'both') {
    if (mode === 'both') console.log(`\n[ RAG + RERANK — minScore ≥ ${MIN_SCORE} ]`);
    await streamRagRerank(question, queryEmbedding);
  }

  console.log(thin);
}

console.log(`\n${divider}`);
console.log(' Готово.');
console.log(divider);
