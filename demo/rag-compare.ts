#!/usr/bin/env tsx
/**
 * RAG Demo — День 22
 *
 * Usage:
 *   tsx demo/rag-compare.ts --mode rag    "Как зовут CEO компании?"
 *   tsx demo/rag-compare.ts --mode no-rag "Как зовут CEO компании?"
 *
 * npm scripts:
 *   npm run demo:rag    -- "вопрос"
 *   npm run demo:no-rag -- "вопрос"
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
// Parse CLI args
// ---------------------------------------------------------------------------

const rawArgs = process.argv.slice(2);
const modeIdx = rawArgs.indexOf('--mode');

if (modeIdx === -1 || !rawArgs[modeIdx + 1]) {
  console.error('Usage: tsx demo/rag-compare.ts --mode <rag|no-rag> "<question>"');
  process.exit(1);
}

const mode = rawArgs[modeIdx + 1];
if (mode !== 'rag' && mode !== 'no-rag') {
  console.error('Error: --mode must be "rag" or "no-rag"');
  process.exit(1);
}

const questionParts = rawArgs.filter((_, i) => i !== modeIdx && i !== modeIdx + 1);
const question = questionParts.join(' ').trim();

if (!question) {
  console.error('Error: provide a question as the last argument');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Setup: config, secrets, LLM provider
// ---------------------------------------------------------------------------

const projectRoot = process.cwd();
const dbPath = path.join(projectRoot, '.agent', 'data', 'search.db');
const KNOWLEDGE_FILE = 'demo/knowledge.md';

const config = loadProjectConfig(projectRoot);
const secrets = loadSecrets();

const apiKey =
  secrets[config.provider]?.apiKey ??
  (config.provider === 'deepseek' ? process.env.DEEPSEEK_API_KEY : undefined);

const lmStudioUrl =
  secrets.lmstudio?.baseUrl ?? process.env.LMSTUDIO_BASE_URL ?? 'http://localhost:1234/v1';
const deepSeekUrl = secrets.deepseek?.baseUrl ?? process.env.DEEPSEEK_BASE_URL;

const llm =
  config.provider === 'deepseek'
    ? new DeepSeekProvider(apiKey ?? '', config.model, deepSeekUrl)
    : new LMStudioProvider(config.model, lmStudioUrl);

// ---------------------------------------------------------------------------
// Auto-index knowledge.md if not yet in the DB
// ---------------------------------------------------------------------------

async function ensureIndexed(): Promise<void> {
  const db = new SearchDB(dbPath);
  const sources = db.getIndexedSources();
  if (sources.includes(KNOWLEDGE_FILE)) return;

  console.log(`[RAG] knowledge.md не проиндексирована, индексирую...`);

  const e = config.embeddingProvider;
  const embCfg: EmbeddingConfig = { type: e?.type ?? 'ollama', model: e?.model, url: e?.url, apiKey: e?.apiKey };
  const embProvider = createEmbeddingProvider(embCfg);

  const fullPath = path.join(projectRoot, KNOWLEDGE_FILE);
  const text = readFileSync(fullPath, 'utf-8');
  const chunks = chunkFixed(text);

  const texts = chunks.map(c => truncateToTokens(c.content));
  const embeddings = await embProvider.embed(texts);

  const now = Date.now();
  const rows = chunks.map((chunk, i) => {
    const f32 = new Float32Array(embeddings[i]);
    return {
      id: `${KNOWLEDGE_FILE}:fixed:${chunk.chunkIndex}`,
      source: KNOWLEDGE_FILE,
      title: 'knowledge.md',
      section: chunk.section,
      strategy: 'fixed' as const,
      chunk_index: chunk.chunkIndex,
      content: chunk.content,
      token_count: chunk.tokenCount,
      embedding: Buffer.from(f32.buffer),
      indexed_at: now,
    };
  });

  db.insertChunks(rows);
  console.log(`[RAG] Готово: ${rows.length} чанков добавлено в индекс.\n`);
}

// ---------------------------------------------------------------------------
// Stream LLM response to stdout
// ---------------------------------------------------------------------------

async function streamAnswer(messages: Message[]): Promise<void> {
  for await (const chunk of llm.stream(messages, { temperature: 0.3 })) {
    if (chunk.type === 'text') process.stdout.write(chunk.text);
  }
  process.stdout.write('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const divider = '─'.repeat(52);
const label = mode === 'rag' ? '[ RAG ]' : '[ NO-RAG ]';

console.log(`\n${divider}`);
console.log(`${label} ${question}`);
console.log(divider);

if (mode === 'no-rag') {
  // Direct LLM call — no context injected
  await streamAnswer([{ role: 'user', content: question }]);
} else {
  // RAG pipeline: embed → search → inject context → LLM
  await ensureIndexed();

  const db = new SearchDB(dbPath);
  const e2 = config.embeddingProvider;
  const embCfg: EmbeddingConfig = { type: e2?.type ?? 'ollama', model: e2?.model, url: e2?.url, apiKey: e2?.apiKey };
  const embProvider = createEmbeddingProvider(embCfg);

  const [queryEmbedding] = await embProvider.embed([question]);
  const results = db.search(new Float32Array(queryEmbedding), 3, undefined, KNOWLEDGE_FILE);

  if (results.length === 0) {
    console.error('[RAG] Релевантных чанков не найдено.');
    process.exit(1);
  }

  const scores = results.map(r => r.score.toFixed(3)).join(', ');
  console.log(`[RAG] Найдено ${results.length} фрагментов (similarity: ${scores})\n`);

  const context = results.map(r => r.content).join('\n---\n');
  const augmentedQuestion = `Используй только следующий контекст для ответа на вопрос.\n\nКонтекст:\n\n${context}\n\nВопрос: ${question}`;

  await streamAnswer([{ role: 'user', content: augmentedQuestion }]);
}
