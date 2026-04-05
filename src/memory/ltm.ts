import Database from 'better-sqlite3';
import path from 'path';
import { mkdirSync } from 'fs';
import type { Task } from '../core/task-state.js';

export interface Fact {
  key: string;
  session_id: string;
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

export interface SessionRow {
  id: string;
  user_name: string;
  started_at: number;
  ended_at: number | null;
  task: string | null;
  invariants: string; // JSON array string
  ctx_pct: number;
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
    // --- Summaries table (unchanged) ---
    this.db.exec(`
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

    // --- Facts table: create with new schema or migrate old schema ---
    const factsExists =
      this.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='facts'")
        .get() != null;

    if (!factsExists) {
      // Fresh install: create with composite PK (key, session_id)
      this.db.exec(`
        CREATE TABLE facts (
          key TEXT NOT NULL,
          session_id TEXT NOT NULL,
          value TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (key, session_id)
        );

        CREATE VIRTUAL TABLE facts_fts USING fts5(
          key, value,
          content=facts,
          content_rowid=rowid
        );

        CREATE TRIGGER facts_ai AFTER INSERT ON facts BEGIN
          INSERT INTO facts_fts(rowid, key, value) VALUES (new.rowid, new.key, new.value);
        END;

        CREATE TRIGGER facts_au AFTER UPDATE ON facts BEGIN
          INSERT INTO facts_fts(facts_fts, rowid, key, value) VALUES ('delete', old.rowid, old.key, old.value);
          INSERT INTO facts_fts(rowid, key, value) VALUES (new.rowid, new.key, new.value);
        END;
      `);
    } else {
      // Upgrade: check if session_id column already exists
      const cols = (this.db.pragma('table_info(facts)') as Array<{ name: string }>).map(
        (c) => c.name,
      );
      if (!cols.includes('session_id')) {
        // Migrate from old schema (key TEXT PRIMARY KEY) to new (key, session_id) composite PK
        this.db.exec(`
          DROP TRIGGER IF EXISTS facts_ai;
          DROP TRIGGER IF EXISTS facts_au;
          DROP TABLE IF EXISTS facts_fts;

          CREATE TABLE facts_v2 (
            key TEXT NOT NULL,
            session_id TEXT NOT NULL,
            value TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (key, session_id)
          );

          INSERT INTO facts_v2 (key, session_id, value, created_at, updated_at)
          SELECT key, 'legacy', value, created_at, updated_at FROM facts;

          DROP TABLE facts;
          ALTER TABLE facts_v2 RENAME TO facts;

          CREATE VIRTUAL TABLE facts_fts USING fts5(
            key, value,
            content=facts,
            content_rowid=rowid
          );

          INSERT INTO facts_fts(facts_fts) VALUES ('rebuild');

          CREATE TRIGGER facts_ai AFTER INSERT ON facts BEGIN
            INSERT INTO facts_fts(rowid, key, value) VALUES (new.rowid, new.key, new.value);
          END;

          CREATE TRIGGER facts_au AFTER UPDATE ON facts BEGIN
            INSERT INTO facts_fts(facts_fts, rowid, key, value) VALUES ('delete', old.rowid, old.key, old.value);
            INSERT INTO facts_fts(rowid, key, value) VALUES (new.rowid, new.key, new.value);
          END;
        `);
      }
    }

    // --- Sessions table new columns (idempotent via try/catch) ---
    const sessionCols = (
      this.db.pragma('table_info(sessions)') as Array<{ name: string }>
    ).map((c) => c.name);

    if (!sessionCols.includes('invariants')) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN invariants TEXT NOT NULL DEFAULT '[]'`);
    }
    if (!sessionCols.includes('ctx_pct')) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN ctx_pct INTEGER NOT NULL DEFAULT 0`);
    }
    if (!sessionCols.includes('task_json')) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN task_json TEXT`);
    }
  }

  // --- Facts ---

  saveFact(key: string, value: string, sessionId: string): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO facts (key, session_id, value, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key, session_id) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
      )
      .run(key, sessionId, value, now, now);
  }

  getFactsBySession(sessionId: string): Fact[] {
    return this.db
      .prepare('SELECT * FROM facts WHERE session_id = ? ORDER BY updated_at DESC')
      .all(sessionId) as Fact[];
  }

  // --- Summaries ---

  saveSessionSummary(sessionId: string, summary: string): void {
    this.db.prepare('INSERT INTO summaries (session_id, summary, timestamp) VALUES (?, ?, ?)').run(
      sessionId,
      summary,
      Date.now(),
    );
  }

  getSessionSummaries(sessionId: string): SessionSummary[] {
    return this.db
      .prepare('SELECT * FROM summaries WHERE session_id = ? ORDER BY timestamp ASC')
      .all(sessionId) as SessionSummary[];
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

  // --- Sessions ---

  saveSession(id: string, userName: string, task: string | null): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO sessions (id, user_name, started_at, task, invariants, ctx_pct)
         VALUES (?, ?, ?, ?, '[]', 0)`,
      )
      .run(id, userName, Date.now(), task);
  }

  endSession(id: string, task: string | null): void {
    this.db.prepare('UPDATE sessions SET ended_at=?, task=? WHERE id=?').run(Date.now(), task, id);
  }

  updateSessionTitle(sessionId: string, title: string): void {
    this.db.prepare('UPDATE sessions SET task=? WHERE id=?').run(title, sessionId);
  }

  updateSessionCtxPct(sessionId: string, pct: number): void {
    this.db.prepare('UPDATE sessions SET ctx_pct=? WHERE id=?').run(pct, sessionId);
  }

  getSessionList(userName: string): SessionRow[] {
    return this.db
      .prepare(
        `SELECT id, user_name, started_at, ended_at, task, invariants, ctx_pct
         FROM sessions WHERE user_name = ? ORDER BY started_at DESC`,
      )
      .all(userName) as SessionRow[];
  }

  getSession(sessionId: string): SessionRow | null {
    return (
      (this.db
        .prepare('SELECT * FROM sessions WHERE id = ?')
        .get(sessionId) as SessionRow | undefined) ?? null
    );
  }

  deleteSession(sessionId: string): void {
    this.db.prepare('DELETE FROM facts WHERE session_id = ?').run(sessionId);
    this.db.prepare('DELETE FROM summaries WHERE session_id = ?').run(sessionId);
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  }

  // --- Session-local invariants ---

  saveSessionInvariant(sessionId: string, rule: string): void {
    const row = this.db
      .prepare('SELECT invariants FROM sessions WHERE id = ?')
      .get(sessionId) as { invariants: string } | undefined;
    if (!row) return;
    const existing: string[] = JSON.parse(row.invariants || '[]');
    if (!existing.includes(rule)) {
      existing.push(rule);
      this.db
        .prepare('UPDATE sessions SET invariants=? WHERE id=?')
        .run(JSON.stringify(existing), sessionId);
    }
  }

  getSessionInvariants(sessionId: string): string[] {
    const row = this.db
      .prepare('SELECT invariants FROM sessions WHERE id = ?')
      .get(sessionId) as { invariants: string } | undefined;
    if (!row) return [];
    try {
      return JSON.parse(row.invariants || '[]') as string[];
    } catch {
      return [];
    }
  }

  // --- Task state ---

  saveTaskState(sessionId: string, task: Task): void {
    this.db
      .prepare('UPDATE sessions SET task_json=? WHERE id=?')
      .run(JSON.stringify(task), sessionId);
  }

  getTaskState(sessionId: string): Task | null {
    const row = this.db
      .prepare('SELECT task_json FROM sessions WHERE id=?')
      .get(sessionId) as { task_json: string | null } | undefined;
    if (!row?.task_json) return null;
    try {
      return JSON.parse(row.task_json) as Task;
    } catch {
      return null;
    }
  }

  close(): void {
    this.db.close();
  }
}
