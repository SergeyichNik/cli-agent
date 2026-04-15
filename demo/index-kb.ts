#!/usr/bin/env tsx
/**
 * Индексация базы знаний demo/kb/ в векторную БД.
 *
 * Запускать один раз перед demo:rag / demo:rag-rerank / demo:benchmark.
 *
 * Usage:
 *   npm run demo:index
 */

import path from 'path';
import { readdirSync, statSync, readFileSync } from 'fs';
import { SearchDB } from '../mcp-servers/search/db.js';
import { createProvider as createEmbeddingProvider, type EmbeddingConfig } from '../mcp-servers/search/embeddings.js';
import { chunkFixed, truncateToTokens } from '../mcp-servers/search/chunker.js';
import { loadProjectConfig } from '../src/agent/config.js';

const KB_DIR = 'demo/kb';
const projectRoot = process.cwd();
const dbPath = path.join(projectRoot, '.agent', 'data', 'search.db');
const config = loadProjectConfig(projectRoot);

function walkKbFiles(dir: string, baseDir: string): string[] {
  const results: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      results.push(...walkKbFiles(full, baseDir));
    } else if (name.endsWith('.md')) {
      results.push(path.relative(baseDir, full));
    }
  }
  return results;
}

const db = new SearchDB(dbPath);
const indexed = new Set(db.getIndexedSources());
const kbFiles = walkKbFiles(path.join(projectRoot, KB_DIR), projectRoot);
const missing = kbFiles.filter(f => !indexed.has(f));

if (missing.length === 0) {
  console.log(`Индекс актуален: ${kbFiles.length} файлов уже проиндексированы.`);
  process.exit(0);
}

console.log(`Индексирую ${missing.length} из ${kbFiles.length} файлов...`);

const e = config.embeddingProvider;
const embCfg: EmbeddingConfig = { type: e?.type ?? 'ollama', model: e?.model, url: e?.url, apiKey: e?.apiKey };
const embProvider = createEmbeddingProvider(embCfg);
const now = Date.now();

for (const relPath of missing) {
  process.stdout.write(`  ${relPath}... `);
  const text = readFileSync(path.join(projectRoot, relPath), 'utf-8');
  const chunks = chunkFixed(text);
  const embeddings: number[][] = [];
  for (const chunk of chunks) {
    const [emb] = await embProvider.embed([truncateToTokens(chunk.content, 250)]);
    embeddings.push(emb);
  }
  db.insertChunks(chunks.map((chunk, i) => ({
    id: `${relPath}:fixed:${chunk.chunkIndex}`,
    source: relPath,
    title: path.basename(relPath),
    section: chunk.section,
    strategy: 'fixed' as const,
    chunk_index: chunk.chunkIndex,
    content: chunk.content,
    token_count: chunk.tokenCount,
    embedding: Buffer.from(new Float32Array(embeddings[i]).buffer),
    indexed_at: now,
  })));
  console.log(`${chunks.length} чанков`);
}

console.log(`\nГотово. Проиндексировано ${missing.length} файлов.`);
