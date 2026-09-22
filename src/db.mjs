// SQLite storage on top of Node's built-in `node:sqlite` (no native addons).
//
// Tables:
//   projects      one row per project identity (see project.mjs)
//   sessions      one row per Claude Code session: short `summary` + JSON `details`
//   session_files files touched per session, for "what touched X?" queries
//   sessions_fts  FTS5 index over title + summary + a body of prompts/files/commands

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dbPath as defaultDbPath } from './config.mjs';

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  root_path     TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title       TEXT NOT NULL DEFAULT '',
  branch      TEXT,
  cwd         TEXT,
  started_at  TEXT,
  ended_at    TEXT,
  updated_at  TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active',
  end_reason  TEXT,
  summary     TEXT NOT NULL,
  details     TEXT NOT NULL,
  prompts     INTEGER NOT NULL DEFAULT 0,
  tool_calls  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS sessions_project_updated ON sessions(project_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS session_files (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  path       TEXT NOT NULL,
  kind       TEXT NOT NULL,
  ops        INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (session_id, path)
);
CREATE INDEX IF NOT EXISTS session_files_path ON session_files(path);
CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
  session_id UNINDEXED,
  title,
  summary,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);
`;

export class MemoryDb {
  /** @param {string} [path] defaults to config.dbPath; ':memory:' for tests */
  constructor(path = defaultDbPath) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 3000');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(SCHEMA);
    this.db
      .prepare('INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)')
      .run('schema_version', String(SCHEMA_VERSION));
  }

  close() {
    this.db.close();
  }

  // --- projects -------------------------------------------------------------

  upsertProject({ id, name, root }, now = new Date().toISOString()) {
    this.db
      .prepare(
        `INSERT INTO projects(id, name, root_path, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, root_path = excluded.root_path, last_seen_at = excluded.last_seen_at`,
      )
      .run(id, name, root, now, now);
  }

  listProjects() {
    return this.db
      .prepare(
        `SELECT p.*, COUNT(s.id) AS sessions FROM projects p LEFT JOIN sessions s ON s.project_id = p.id
         GROUP BY p.id ORDER BY p.last_seen_at DESC`,
      )
      .all();
  }

  // --- sessions -------------------------------------------------------------

  /**
   * Insert or replace a session together with its files and FTS row.
   * Idempotent: the Stop hook calls this after every turn.
   */
  upsertSession(row, files) {
    const now = new Date().toISOString();
    const details = typeof row.details === 'string' ? row.details : JSON.stringify(row.details ?? {});
    const body = fulltextBody(row.details, files);
    const tx = this.db;
    tx.exec('BEGIN');
    try {
      tx.prepare(
        `INSERT INTO sessions(id, project_id, title, branch, cwd, started_at, ended_at, updated_at, status, end_reason, summary, details, prompts, tool_calls)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           project_id = excluded.project_id, title = excluded.title, branch = excluded.branch, cwd = excluded.cwd,
           started_at = COALESCE(sessions.started_at, excluded.started_at), ended_at = excluded.ended_at,
           updated_at = excluded.updated_at, status = excluded.status,
           end_reason = COALESCE(excluded.end_reason, sessions.end_reason),
           summary = excluded.summary, details = excluded.details, prompts = excluded.prompts, tool_calls = excluded.tool_calls`,
      ).run(
        row.id,
        row.projectId,
        row.title ?? '',
        row.branch ?? null,
        row.cwd ?? null,
        row.startedAt ?? null,
        row.endedAt ?? null,
        now,
        row.status ?? 'active',
        row.endReason ?? null,
        row.summary,
        details,
        row.prompts ?? 0,
        row.toolCalls ?? 0,
      );
      tx.prepare('DELETE FROM session_files WHERE session_id = ?').run(row.id);
      const insFile = tx.prepare('INSERT OR REPLACE INTO session_files(session_id, path, kind, ops) VALUES (?, ?, ?, ?)');
      for (const f of files ?? []) insFile.run(row.id, f.path, f.kind, f.ops ?? 1);
      tx.prepare('DELETE FROM sessions_fts WHERE session_id = ?').run(row.id);
      tx.prepare('INSERT INTO sessions_fts(session_id, title, summary, body) VALUES (?, ?, ?, ?)').run(
        row.id,
        row.title ?? '',
        row.summary,
        body,
      );
      tx.exec('COMMIT');
    } catch (err) {
      tx.exec('ROLLBACK');
      throw err;
    }
  }

  getSession(idOrPrefix) {
    return (
      this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(idOrPrefix) ??
      this.db.prepare('SELECT * FROM sessions WHERE id LIKE ? ORDER BY updated_at DESC LIMIT 1').get(`${idOrPrefix}%`) ??
      null
    );
  }

  getSessionFiles(sessionId) {
    return this.db.prepare('SELECT path, kind, ops FROM session_files WHERE session_id = ? ORDER BY kind, path').all(sessionId);
  }

  /** Most recent sessions, optionally scoped to a project and excluding one id. */
  recentSessions({ projectId = null, limit = 5, excludeId = null } = {}) {
    const where = [];
    const params = [];
    if (projectId) {
      where.push('project_id = ?');
      params.push(projectId);
    }
    if (excludeId) {
      where.push('id != ?');
      params.push(excludeId);
    }
    const sql = `SELECT * FROM sessions ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY updated_at DESC LIMIT ?`;
    return this.db.prepare(sql).all(...params, limit);
  }

  countSessions(projectId = null) {
    return projectId
      ? this.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE project_id = ?').get(projectId).n
      : this.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n;
  }

  /**
   * Full-text search. Terms are AND-ed with prefix matching; when that yields
   * nothing we retry with OR so a partially-wrong query still returns something.
   */
  search(query, { projectId = null, limit = 10 } = {}) {
    const terms = ftsTerms(query);
    if (!terms.length) return [];
    const run = (match) => {
      const where = ['sessions_fts MATCH ?'];
      const params = [match];
      if (projectId) {
        where.push('s.project_id = ?');
        params.push(projectId);
      }
      return this.db
        .prepare(
          `SELECT s.*, bm25(sessions_fts, 0, 10.0, 5.0, 1.0) AS rank
           FROM sessions_fts JOIN sessions s ON s.id = sessions_fts.session_id
           WHERE ${where.join(' AND ')} ORDER BY rank LIMIT ?`,
        )
        .all(...params, limit);
    };
    const strict = run(terms.join(' AND '));
    if (strict.length || terms.length === 1) return strict;
    return run(terms.join(' OR '));
  }

  /** Sessions whose recorded files contain `fragment` (case-insensitive substring). */
  searchByFile(fragment, { projectId = null, limit = 10 } = {}) {
    const params = [`%${fragment.replace(/\\/g, '/')}%`];
    let sql = `SELECT DISTINCT s.* FROM session_files f JOIN sessions s ON s.id = f.session_id WHERE f.path LIKE ? COLLATE NOCASE`;
    if (projectId) {
      sql += ' AND s.project_id = ?';
      params.push(projectId);
    }
    sql += ' ORDER BY s.updated_at DESC LIMIT ?';
    return this.db.prepare(sql).all(...params, limit);
  }

  deleteSession(id) {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM sessions_fts WHERE session_id = ?').run(id);
      const r = this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
      this.db.exec('COMMIT');
      return r.changes;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  deleteProject(projectId) {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM sessions_fts WHERE session_id IN (SELECT id FROM sessions WHERE project_id = ?)').run(projectId);
      const r = this.db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
      this.db.exec('COMMIT');
      return r.changes;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
}

/** Text that goes into the FTS `body` column. */
function fulltextBody(details, files) {
  const d = typeof details === 'string' ? safeJson(details) : details ?? {};
  const chunks = [];
  for (const p of d.prompts ?? []) chunks.push(p.text);
  for (const f of files ?? []) chunks.push(f.path);
  for (const c of d.commands ?? []) chunks.push(c);
  if (d.outcome) chunks.push(d.outcome);
  return chunks.join('\n');
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

/**
 * Turn free text into safe FTS5 terms: each token becomes a quoted prefix
 * query ("foo"*), which sidesteps FTS5 operator syntax entirely.
 */
export function ftsTerms(query) {
  return String(query ?? '')
    .split(/[\s,;]+/)
    .map((t) => t.replace(/"/g, '').trim())
    .filter((t) => t.length >= 2)
    .slice(0, 12)
    .map((t) => `"${t}"*`);
}
