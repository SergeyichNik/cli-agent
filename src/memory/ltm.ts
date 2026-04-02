import Database from 'better-sqlite3';
import path from 'path';
import { mkdirSync } from 'fs';

export interface Fact {
  key: string;
  value: string;
  created_at: number;
  updated_at: number;
}

export interface SessionSummary {
  id: number;
  session_id: string;
  summary: string;
  timestamp: number;
}

export class LongTermMemory {
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS facts (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
        key, value,
        content=facts,
        content_rowid=rowid
      );

      CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
        INSERT INTO facts_fts(rowid, key, value) VALUES (new.rowid, new.key, new.value);
      END;

      CREATE TRIGGER IF NOT EXISTS facts_au AFTER UPDATE ON facts BEGIN
        INSERT INTO facts_fts(facts_fts, rowid, key, value) VALUES ('delete', old.rowid, old.key, old.value);
        INSERT INTO facts_fts(rowid, key, value) VALUES (new.rowid, new.key, new.value);
      END;

      CREATE TABLE IF NOT EXISTS summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS summaries_fts USING fts5(
        summary,
        content=summaries,
        content_rowid=id
      );

      CREATE TRIGGER IF NOT EXISTS summaries_ai AFTER INSERT ON summaries BEGIN
        INSERT INTO summaries_fts(rowid, summary) VALUES (new.id, new.summary);
      END;

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_name TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        task TEXT
      );
    `);
  }

  saveFact(key: string, value: string): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO facts (key, value, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
      )
      .run(key, value, now, now);
  }

  getFacts(): Fact[] {
    return this.db.prepare('SELECT * FROM facts ORDER BY updated_at DESC').all() as Fact[];
  }

  saveSessionSummary(sessionId: string, summary: string): void {
    this.db.prepare('INSERT INTO summaries (session_id, summary, timestamp) VALUES (?, ?, ?)').run(
      sessionId,
      summary,
      Date.now(),
    );
  }

  searchRelevant(query: string, limit = 5): SessionSummary[] {
    try {
      return this.db
        .prepare(
          `SELECT s.id, s.session_id, s.summary, s.timestamp
           FROM summaries_fts
           JOIN summaries s ON s.id = summaries_fts.rowid
           WHERE summaries_fts MATCH ?
           ORDER BY s.timestamp DESC
           LIMIT ?`,
        )
        .all(query, limit) as SessionSummary[];
    } catch {
      return [];
    }
  }

  saveSession(id: string, userName: string, task: string | null): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO sessions (id, user_name, started_at, task) VALUES (?, ?, ?, ?)`,
      )
      .run(id, userName, Date.now(), task);
  }

  endSession(id: string, task: string | null): void {
    this.db.prepare('UPDATE sessions SET ended_at=?, task=? WHERE id=?').run(Date.now(), task, id);
  }

  close(): void {
    this.db.close();
  }
}
