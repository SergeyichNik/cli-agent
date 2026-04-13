import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { readFile } from 'fs/promises';
import path from 'path';
import { SearchDB } from './db.js';
import { createProvider, type EmbeddingConfig } from './embeddings.js';
import { chunkFixed, chunkStructural, truncateToTokens } from './chunker.js';
import type { RawChunk } from './chunker.js';

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const sandboxDir = process.env.SANDBOX_DIR
  ? path.resolve(process.env.SANDBOX_DIR)
  : process.cwd();

const dbPath = path.join(sandboxDir, '.agent', 'data', 'search.db');
const db = new SearchDB(dbPath);

function loadEmbeddingConfig(): EmbeddingConfig {
  const configPath = path.join(sandboxDir, '.agent', 'config.json');
  if (!existsSync(configPath)) return { type: 'ollama' };
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    if (raw.embeddingProvider && typeof raw.embeddingProvider === 'object') {
      return raw.embeddingProvider as EmbeddingConfig;
    }
  } catch {
    // fallback to default
  }
  return { type: 'ollama' };
}

const embeddingProvider = createProvider(loadEmbeddingConfig());

// ---------------------------------------------------------------------------
// Glob file walker (no external deps)
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out',
  '.agent', '.next', '.nuxt', '.turbo', '.cache',
  '__pycache__', 'coverage', '.nyc_output', 'test-results',
  'vendor', 'tmp', 'temp',
]);

const SKIP_EXTENSIONS = new Set(['.d.ts']); // generated declaration files — not useful for search

function shouldSkipFile(name: string): boolean {
  if (name.endsWith('.d.ts')) return true;
  const ext = name.lastIndexOf('.');
  return ext !== -1 && SKIP_EXTENSIONS.has(name.slice(ext));
}
const MAX_FILE_BYTES = 500 * 1024; // 500 KB

function walkFiles(dir: string, baseDir: string): string[] {
  const results: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir) as string[];
  } catch {
    return results;
  }
  for (const name of names) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    try {
      const s = statSync(full);
      if (s.isDirectory()) {
        results.push(...walkFiles(full, baseDir));
      } else if (s.isFile() && !shouldSkipFile(name)) {
        results.push(path.relative(baseDir, full));
      }
    } catch {
      continue;
    }
  }
  return results;
}

function matchGlob(filePath: string, pattern: string): boolean {
  // Normalize separators
  const fp = filePath.replace(/\\/g, '/');
  const pat = pattern.replace(/\\/g, '/');

  // Convert glob pattern to regex
  const regexStr = pat
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // escape regex special chars (not * or ?)
    .replace(/\\\*/g, '*')                   // un-escape * so we can process them
    .replace(/\*\*\//g, '(.+/)?')           // **/ matches zero or more path segments
    .replace(/\*\*/g, '.*')                 // ** matches anything
    .replace(/\*/g, '[^/]*')                // * matches within a segment
    .replace(/\?/g, '[^/]');                // ? matches single char

  return new RegExp(`^${regexStr}$`).test(fp);
}

function globFiles(pattern: string): string[] {
  const allFiles = walkFiles(sandboxDir, sandboxDir);
  return allFiles.filter(f => matchGlob(f, pattern));
}

// ---------------------------------------------------------------------------
// Batch embedding helper
// ---------------------------------------------------------------------------

const EMBED_BATCH_SIZE = 20;

async function embedInBatches(texts: string[]): Promise<number[][]> {
  const results: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
    const embeddings = await embeddingProvider.embed(batch);
    results.push(...embeddings);
  }
  return results;
}

function float32ToBuffer(arr: number[]): Buffer {
  const f32 = new Float32Array(arr);
  return Buffer.from(f32.buffer);
}

// ---------------------------------------------------------------------------
// Core indexing logic
// ---------------------------------------------------------------------------

type Strategy = 'fixed' | 'structural' | 'both';

async function indexFiles(files: string[], strategy: Strategy): Promise<string> {
  const strategies: Array<'fixed' | 'structural'> =
    strategy === 'both' ? ['fixed', 'structural'] : [strategy];

  const now = Date.now();
  let totalInserted = 0;

  for (const strat of strategies) {
    const allChunks: { source: string; chunk: RawChunk }[] = [];

    for (const relPath of files) {
      const fullPath = path.join(sandboxDir, relPath);
      let text: string;
      try {
        const stat = statSync(fullPath);
        if (stat.size > MAX_FILE_BYTES) continue;
        text = await readFile(fullPath, 'utf-8');
      } catch {
        continue;
      }

      const chunks = strat === 'fixed'
        ? chunkFixed(text)
        : chunkStructural(text, relPath);

      for (const chunk of chunks) {
        allChunks.push({ source: relPath, chunk });
      }
    }

    // Embed all chunks in batches (truncate oversized chunks to model context limit)
    const texts = allChunks.map(c => truncateToTokens(c.chunk.content));
    const embeddings = await embedInBatches(texts);

    const rows = allChunks.map(({ source, chunk }, i) => ({
      id: `${source}:${strat}:${chunk.chunkIndex}`,
      source,
      title: path.basename(source),
      section: chunk.section,
      strategy: strat as 'fixed' | 'structural',
      chunk_index: chunk.chunkIndex,
      content: chunk.content,
      token_count: chunk.tokenCount,
      embedding: float32ToBuffer(embeddings[i]),
      indexed_at: now,
    }));

    db.insertChunks(rows);
    totalInserted += rows.length;
  }

  // Build comparison output when both strategies used
  if (strategy === 'both') {
    const fixedStats = db.getChunkStats('fixed');
    const structStats = db.getChunkStats('structural');
    return [
      `Indexed ${files.length} files with both strategies.\n`,
      `Strategy comparison:`,
      `  Fixed:      ${fixedStats.count.toString().padStart(4)} chunks | avg ${fixedStats.avgTokens.toString().padStart(4)} tokens | min ${fixedStats.minTokens} | max ${fixedStats.maxTokens}`,
      `  Structural: ${structStats.count.toString().padStart(4)} chunks | avg ${structStats.avgTokens.toString().padStart(4)} tokens | min ${structStats.minTokens} | max ${structStats.maxTokens}`,
    ].join('\n');
  }

  return `Indexed ${files.length} files → ${totalInserted} chunks (strategy: ${strategy}).`;
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({ name: 'search', version: '1.0.0' });

// --- Tool: index_documents ---
server.registerTool('index_documents', {
  description:
    'Index files from the sandbox into the vector search database. Supports glob patterns ' +
    'like "**/*.ts", "**/*.md", "src/**/*.ts". Use strategy "both" to index with both chunking ' +
    'strategies and see a comparison.',
  inputSchema: {
    glob: z.string().describe('Glob pattern for files to index (e.g. "**/*.ts", "**/*.md")'),
    strategy: z
      .enum(['fixed', 'structural', 'both'])
      .default('both')
      .describe(
        'Chunking strategy: "fixed" = 512-token sliding window, ' +
        '"structural" = by headings/exports, "both" = index with both and compare',
      ),
  },
}, async ({ glob, strategy }) => {
  const files = globFiles(glob);
  if (files.length === 0) {
    return { content: [{ type: 'text' as const, text: `No files matched pattern: ${glob}` }] };
  }
  try {
    const result = await indexFiles(files, strategy);
    return { content: [{ type: 'text' as const, text: result }] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text' as const, text: `Indexing failed: ${msg}` }] };
  }
});

// --- Tool: search ---
server.registerTool('search', {
  description:
    'Semantic search over the indexed documents. Returns the most relevant chunks with ' +
    'source file, section, content, and similarity score.',
  inputSchema: {
    query: z.string().describe('Natural language search query'),
    topK: z.number().int().min(1).max(20).default(5).describe('Number of results to return'),
    strategy: z
      .enum(['fixed', 'structural'])
      .optional()
      .describe('Filter results to a specific chunking strategy'),
    source: z.string().optional().describe('Filter by source file path (partial match)'),
  },
}, async ({ query, topK, strategy, source }) => {
  const statusInfo = db.getStatus();
  if (statusInfo.totalChunks === 0) {
    return {
      content: [{
        type: 'text' as const,
        text: 'Index is empty. Run index_documents first.',
      }],
    };
  }

  let queryEmbedding: number[];
  try {
    [queryEmbedding] = await embeddingProvider.embed([query]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text' as const, text: `Embedding query failed: ${msg}` }] };
  }

  const results = db.search(new Float32Array(queryEmbedding), topK ?? 5, strategy, source);
  if (results.length === 0) {
    return { content: [{ type: 'text' as const, text: 'No results found.' }] };
  }

  const lines = results.map((r, i) => [
    `[${i + 1}] ${r.source}${r.section ? ` § ${r.section}` : ''} (score: ${r.score.toFixed(4)}, strategy: ${r.strategy})`,
    r.content.slice(0, 400) + (r.content.length > 400 ? '…' : ''),
  ].join('\n'));

  return { content: [{ type: 'text' as const, text: lines.join('\n\n---\n\n') }] };
});

// --- Tool: index_status ---
server.registerTool('index_status', {
  description: 'Show the current state of the search index: total chunks, breakdown by strategy and source file.',
  inputSchema: {},
}, async () => {
  const status = db.getStatus();

  if (status.totalChunks === 0) {
    return { content: [{ type: 'text' as const, text: 'Index is empty. Run index_documents to populate it.' }] };
  }

  const lastIndexed = status.lastIndexed
    ? new Date(status.lastIndexed).toLocaleString()
    : 'unknown';

  const stratLines = Object.entries(status.byStrategy)
    .map(([strat, n]) => {
      const stats = db.getChunkStats(strat);
      return `  ${strat.padEnd(12)} ${n.toString().padStart(5)} chunks | avg ${stats.avgTokens} tokens`;
    })
    .join('\n');

  const sourceLines = status.bySources
    .slice(0, 10)
    .map(s => `  ${s.source.padEnd(50)} ${s.count} chunks`)
    .join('\n');

  const text = [
    `Total chunks: ${status.totalChunks}`,
    `Last indexed: ${lastIndexed}`,
    ``,
    `By strategy:`,
    stratLines,
    ``,
    `Top sources:`,
    sourceLines,
    status.bySources.length > 10 ? `  … and ${status.bySources.length - 10} more` : '',
  ].filter(l => l !== '').join('\n');

  return { content: [{ type: 'text' as const, text }] };
});

// --- Tool: reindex ---
server.registerTool('reindex', {
  description:
    'Delete existing index entries for matching files and re-index them. ' +
    'If glob is omitted, re-indexes all previously indexed sources.',
  inputSchema: {
    glob: z
      .string()
      .optional()
      .describe('Glob pattern for files to reindex. Omit to reindex all previously indexed files.'),
    strategy: z
      .enum(['fixed', 'structural', 'both'])
      .default('both')
      .describe('Chunking strategy to use for reindexing'),
  },
}, async ({ glob, strategy }) => {
  let files: string[];

  if (glob) {
    files = globFiles(glob);
    if (files.length === 0) {
      return { content: [{ type: 'text' as const, text: `No files matched pattern: ${glob}` }] };
    }
  } else {
    files = db.getIndexedSources();
    if (files.length === 0) {
      return { content: [{ type: 'text' as const, text: 'Index is empty. Nothing to reindex.' }] };
    }
  }

  db.deleteBySource(files);

  try {
    const result = await indexFiles(files, strategy);
    return { content: [{ type: 'text' as const, text: `Reindexed ${files.length} files.\n${result}` }] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text' as const, text: `Reindex failed: ${msg}` }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
