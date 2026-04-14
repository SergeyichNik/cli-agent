#!/usr/bin/env tsx
/**
 * RAG Benchmark — прогоняет все 10 вопросов в обоих режимах и выводит сравнение.
 *
 * Usage:
 *   tsx demo/rag-benchmark.ts
 *   npm run demo:benchmark
 */

import path from 'path';
import { readFileSync } from 'fs';
import { SearchDB } from '../mcp-servers/search/db.js';
import { createProvider as createEmbeddingProvider, type EmbeddingConfig } from '../mcp-servers/search/embeddings.js';
import { chunkFixed, truncateToTokens } from '../mcp-servers/search/chunker.js';
import { loadProjectConfig } from '../src/agent/config.js';
import { loadSecrets } from '../src/agent/secrets.js';
import { DeepSeekProvider } from '../src/providers/deepseek.js';
import { LMStudioProvider } from '../src/providers/lmstudio.js';
import type { Message } from '../src/providers/base.js';

// ---------------------------------------------------------------------------
// CLI args: --mode rag | no-rag | both (default: both)
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const modeIdx = args.indexOf('--mode');
const mode = (modeIdx !== -1 ? args[modeIdx + 1] : 'both') as 'rag' | 'no-rag' | 'both';
if (!['rag', 'no-rag', 'both'].includes(mode)) {
  console.error('Usage: tsx demo/rag-benchmark.ts [--mode rag|no-rag|both]');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 10 контрольных вопросов
// ---------------------------------------------------------------------------

const QUESTIONS = [
  'Как зовут CEO компании?',
  'Где находится главный офис?',
  'Сколько длится рабочий день?',
  'На каком языке программирования работает компания?',
  'Чем выплачивается зарплата?',
  'Как называется фирменный напиток?',
  'Сколько сотрудников в компании?',
  'Как называется корпоративный гимн?',
  'Когда была основана компания?',
  'Как добраться до офиса?',
];

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const projectRoot = process.cwd();
const dbPath = path.join(projectRoot, '.agent', 'data', 'search.db');
const KNOWLEDGE_FILE = 'demo/knowledge.md';

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

function getEmbCfg(): EmbeddingConfig {
  const e = config.embeddingProvider;
  return { type: e?.type ?? 'ollama', model: e?.model, url: e?.url, apiKey: e?.apiKey };
}

// ---------------------------------------------------------------------------
// Auto-index
// ---------------------------------------------------------------------------

async function ensureIndexed(): Promise<void> {
  const db = new SearchDB(dbPath);
  if (db.getIndexedSources().includes(KNOWLEDGE_FILE)) return;

  console.log('Индексирую knowledge.md...');
  const embProvider = createEmbeddingProvider(getEmbCfg());
  const text = readFileSync(path.join(projectRoot, KNOWLEDGE_FILE), 'utf-8');
  const chunks = chunkFixed(text);
  const embeddings = await embProvider.embed(chunks.map(c => truncateToTokens(c.content)));
  const now = Date.now();
  const db2 = new SearchDB(dbPath);
  db2.insertChunks(chunks.map((chunk, i) => ({
    id: `${KNOWLEDGE_FILE}:fixed:${chunk.chunkIndex}`,
    source: KNOWLEDGE_FILE,
    title: 'knowledge.md',
    section: chunk.section,
    strategy: 'fixed' as const,
    chunk_index: chunk.chunkIndex,
    content: chunk.content,
    token_count: chunk.tokenCount,
    embedding: Buffer.from(new Float32Array(embeddings[i]).buffer),
    indexed_at: now,
  })));
  console.log(`Готово: ${chunks.length} чанков.\n`);
}

// ---------------------------------------------------------------------------
// Ask helpers (streaming to stdout)
// ---------------------------------------------------------------------------

async function streamNoRag(question: string): Promise<void> {
  for await (const chunk of llm.stream([{ role: 'user', content: question }], { temperature: 0.3 })) {
    if (chunk.type === 'text') process.stdout.write(chunk.text);
  }
  process.stdout.write('\n');
}

async function streamRag(question: string, db: SearchDB): Promise<void> {
  const embProvider = createEmbeddingProvider(getEmbCfg());
  const [queryEmbedding] = await embProvider.embed([question]);
  const results = db.search(new Float32Array(queryEmbedding), 3, undefined, KNOWLEDGE_FILE);
  const scores = results.map(r => r.score.toFixed(3)).join(', ');
  const context = results.map(r => r.content).join('\n---\n');
  const prompt = `Используй только следующий контекст для ответа на вопрос.\n\nКонтекст:\n\n${context}\n\nВопрос: ${question}`;

  console.log(`   (similarity: ${scores})`);
  for await (const chunk of llm.stream([{ role: 'user', content: prompt }], { temperature: 0.3 })) {
    if (chunk.type === 'text') process.stdout.write(chunk.text);
  }
  process.stdout.write('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

if (mode !== 'no-rag') await ensureIndexed();
const db = new SearchDB(dbPath);

const divider = '═'.repeat(70);
const thin = '─'.repeat(70);
const modeLabel = mode === 'rag' ? 'RAG' : mode === 'no-rag' ? 'NO-RAG' : 'RAG vs NO-RAG';

console.log(`\n${divider}`);
console.log(` BENCHMARK [${modeLabel}] — ПингвинТех × 10 вопросов`);
console.log(divider);

for (let i = 0; i < QUESTIONS.length; i++) {
  const question = QUESTIONS[i];

  console.log(`\n[${i + 1}/10] ${question}`);
  console.log(thin);

  if (mode === 'no-rag' || mode === 'both') {
    if (mode === 'both') console.log('[ NO-RAG ]');
    await streamNoRag(question);
  }

  if (mode === 'rag' || mode === 'both') {
    if (mode === 'both') console.log('\n[    RAG ]');
    await streamRag(question, db);
  }

  console.log(thin);
}

console.log(`\n${divider}`);
console.log(' Готово.');
console.log(divider);
