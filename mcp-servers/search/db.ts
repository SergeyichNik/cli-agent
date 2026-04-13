import Database from 'better-sqlite3';
import path from 'path';
import { mkdirSync } from 'fs';

export interface ChunkRow {
  id: string;
  source: string;
  title: string;
  section: string;
  strategy: 'fixed' | 'structural';
  chunk_index: number;
  content: string;
  token_count: number;
  embedding: Buffer;
  indexed_at: number;
}

export interface SearchResult {
  id: string;
  source: string;
  title: string;
  section: string;
  strategy: string;
  chunk_index: number;
  content: string;
  score: number;
}

export interface ChunkStats {
  count: number;
  avgTokens: number;
  minTokens: number;
  maxTokens: number;
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export class SearchDB {
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id           TEXT    PRIMARY KEY,
        source       TEXT    NOT NULL,
        title        TEXT    NOT NULL DEFAULT '',
        section      TEXT    NOT NULL DEFAULT '',
        strategy     TEXT    NOT NULL,
        chunk_index  INTEGER NOT NULL,
        content      TEXT    NOT NULL,
        token_count  INTEGER NOT NULL,
        embedding    BLOB    NOT NULL,
        indexed_at   INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_source   ON chunks(source);
      CREATE INDEX IF NOT EXISTS idx_strategy ON chunks(strategy);
    `);
  }

  insertChunks(rows: ChunkRow[]): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO chunks
        (id, source, title, section, strategy, chunk_index, content, token_count, embedding, indexed_at)
      VALUES
        (@id, @source, @title, @section, @strategy, @chunk_index, @content, @token_count, @embedding, @indexed_at)
    `);
    const insertMany = this.db.transaction((items: ChunkRow[]) => {
      for (const row of items) stmt.run(row);
    });
    insertMany(rows);
  }

  deleteBySource(sources: string[]): void {
    if (sources.length === 0) return;
    const placeholders = sources.map(() => '?').join(',');
    this.db.prepare(`DELETE FROM chunks WHERE source IN (${placeholders})`).run(sources);
  }

  search(queryEmbedding: Float32Array, topK: number, strategy?: string, source?: string): SearchResult[] {
    let sql = `SELECT id, source, title, section, strategy, chunk_index, content, embedding FROM chunks`;
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (strategy) { conditions.push(`strategy = ?`); params.push(strategy); }
    if (source)   { conditions.push(`source LIKE ?`); params.push(`%${source}%`); }
    if (conditions.length > 0) sql += ` WHERE ${conditions.join(' AND ')}`;

    type Row = { id: string; source: string; title: string; section: string; strategy: string; chunk_index: number; content: string; embedding: Buffer };
    const rows = this.db.prepare(sql).all(...params) as Row[];

    const scored = rows.map(row => {
      const emb = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
      const score = cosineSimilarity(queryEmbedding, emb);
      return {
        id: row.id, source: row.source, title: row.title,
        section: row.section, strategy: row.strategy,
        chunk_index: row.chunk_index, content: row.content, score,
      };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  getStatus(): {
    totalChunks: number;
    byStrategy: Record<string, number>;
    bySources: { source: string; count: number }[];
    lastIndexed: number | null;
  } {
    const { n: totalChunks } = this.db.prepare('SELECT COUNT(*) as n FROM chunks').get() as { n: number };
    const stratRows = this.db.prepare('SELECT strategy, COUNT(*) as n FROM chunks GROUP BY strategy').all() as { strategy: string; n: number }[];
    const byStrategy = Object.fromEntries(stratRows.map(r => [r.strategy, r.n]));
    const bySources = this.db.prepare(
      'SELECT source, COUNT(*) as count FROM chunks GROUP BY source ORDER BY count DESC LIMIT 30'
    ).all() as { source: string; count: number }[];
    const { ts } = this.db.prepare('SELECT MAX(indexed_at) as ts FROM chunks').get() as { ts: number | null };
    return { totalChunks, byStrategy, bySources, lastIndexed: ts };
  }

  getIndexedSources(): string[] {
    return (this.db.prepare('SELECT DISTINCT source FROM chunks').all() as { source: string }[]).map(r => r.source);
  }

  getChunkStats(strategy: string): ChunkStats {
    const row = this.db.prepare(
      'SELECT COUNT(*) as count, AVG(token_count) as avg, MIN(token_count) as min, MAX(token_count) as max FROM chunks WHERE strategy = ?'
    ).get(strategy) as { count: number; avg: number; min: number; max: number };
    return { count: row.count, avgTokens: Math.round(row.avg ?? 0), minTokens: row.min ?? 0, maxTokens: row.max ?? 0 };
  }
}
