// SQLite storage on top of Node's built-in `node:sqlite` (no native addons).
//
// Tables:
//   projects      one row per project identity (see project.mjs)
//   sessions      one row per Claude Code session: short `summary` + JSON `details`
//   session_files files touched per session, for "what touched X?" queries
//   sessions_fts  FTS5 index over title + summary + a body of prompts/files/commands/commits
//   segments      the units of work inside a session: one per commit, plus the
//                 uncommitted tail (see segments.mjs)
//   segment_files files edited per segment, for "when did we last touch X?"
//   segments_fts  FTS5 index over a segment's commit subject, prompts, files and note
//   file_hints    which files already got a history hint in a session (hints.mjs)
//   commit_notes  "what" and "why" of a commit, written by a small model (llm.mjs);
//                 keyed by sha because segments are rewritten after every turn
//
// Schema changes are additive (CREATE ... IF NOT EXISTS), so an old database
// simply gains the new tables; rows written before them are re-indexed from
// their transcripts by reindex.mjs.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dbPath as defaultDbPath } from './config.mjs';
import { foldText, stem } from './stem.mjs';

const SCHEMA_VERSION = 2;

/**
 * How indexed text is prepared (see foldText in stem.mjs). A database whose
 * indexes were built another way is re-indexed once when opened.
 */
const SEARCH_INDEX_VERSION = '2';

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
CREATE TABLE IF NOT EXISTS segments (
  session_id     TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq            INTEGER NOT NULL,
  project_id     TEXT NOT NULL,
  started_at     TEXT,
  ended_at       TEXT,
  active_min     INTEGER NOT NULL DEFAULT 0,
  commit_sha     TEXT,
  commit_subject TEXT,
  prompts        TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (session_id, seq)
);
CREATE INDEX IF NOT EXISTS segments_project_ended ON segments(project_id, ended_at DESC);
CREATE INDEX IF NOT EXISTS segments_commit ON segments(commit_sha);
CREATE TABLE IF NOT EXISTS segment_files (
  session_id TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  path       TEXT NOT NULL,
  kind       TEXT NOT NULL,
  ops        INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (session_id, seq, path),
  FOREIGN KEY (session_id, seq) REFERENCES segments(session_id, seq) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS segment_files_path ON segment_files(path);
CREATE TABLE IF NOT EXISTS file_hints (
  session_id TEXT NOT NULL,
  path       TEXT NOT NULL,
  shown_at   TEXT NOT NULL,
  PRIMARY KEY (session_id, path)
);
CREATE TABLE IF NOT EXISTS commit_notes (
  commit_sha TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  session_id TEXT,
  status     TEXT NOT NULL,
  type       TEXT,
  what       TEXT,
  why        TEXT,
  attempts   INTEGER NOT NULL DEFAULT 0,
  error      TEXT,
  model      TEXT,
  cost_usd   REAL,
  created_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS segments_fts USING fts5(
  session_id UNINDEXED,
  seq UNINDEXED,
  subject,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
  session_id UNINDEXED,
  title,
  summary,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);
`;

export class MemoryDb {
  /**
   * @param {string} [path] defaults to config.dbPath; ':memory:' for tests
   * @param {{busyTimeoutMs?: number, maintenance?: boolean}} [opts]
   *        busyTimeoutMs: how long to wait for a writer; a hook that blocks
   *        Claude (file hints) waits briefly and gives up.
   *        maintenance: allow one-off upkeep such as rebuilding the search
   *        index; off for hooks Claude waits on, which must stay fast
   */
  constructor(path = defaultDbPath, { busyTimeoutMs = 3000, maintenance = true } = {}) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))}`);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    try {
      this.db.exec(SCHEMA);
    } catch (err) {
      // Node's bundled SQLite gained FTS5 in 22.16; before that every write
      // would fail with an opaque "no such module". Say what is actually wrong.
      if (/no such module: fts5/i.test(String(err?.message))) {
        throw new Error(`needs Node.js 22.16 or newer (its SQLite lacks full-text search before that); this is Node ${process.version}`);
      }
      throw err;
    }
    this.db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
      'schema_version',
      String(SCHEMA_VERSION),
    );
    if (maintenance && this.getMeta('search_index_version') !== SEARCH_INDEX_VERSION) {
      this.rebuildSearchIndex();
      this.setMeta('search_index_version', SEARCH_INDEX_VERSION);
    }
  }

  /**
   * Rebuild both full-text indexes from the stored rows (no transcripts
   * needed). Run once when the way text is indexed changes.
   */
  rebuildSearchIndex() {
    const sessions = this.db.prepare('SELECT id, project_id, title, summary, details FROM sessions').all();
    const files = this.db.prepare('SELECT path FROM session_files WHERE session_id = ?');
    const ins = this.db.prepare('INSERT INTO sessions_fts(session_id, title, summary, body) VALUES (?, ?, ?, ?)');
    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM sessions_fts');
      this.db.exec('DELETE FROM segments_fts');
      for (const s of sessions) {
        const details = parsedDetails(s.details);
        ins.run(s.id, foldText(s.title ?? ''), foldText(s.summary ?? ''), foldText(fulltextBody(details, files.all(s.id))));
        this.#writeSegments(s.id, s.project_id, details.segments ?? []);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  getMeta(key) {
    return this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
  }

  setMeta(key, value) {
    this.db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
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
    // `updatedAt` lets re-indexing keep a row's place in "most recent" order.
    const now = row.updatedAt ?? new Date().toISOString();
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
        foldText(row.title ?? ''),
        foldText(row.summary),
        foldText(body),
      );
      this.#writeSegments(row.id, row.projectId, parsedDetails(row.details).segments ?? []);
      tx.exec('COMMIT');
    } catch (err) {
      tx.exec('ROLLBACK');
      throw err;
    }
  }

  /** Replace a session's segments (inside the caller's transaction). */
  #writeSegments(sessionId, projectId, segments) {
    const db = this.db;
    db.prepare('DELETE FROM segments_fts WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM segment_files WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM segments WHERE session_id = ?').run(sessionId);
    const insSeg = db.prepare(
      `INSERT INTO segments(session_id, seq, project_id, started_at, ended_at, active_min, commit_sha, commit_subject, prompts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insFile = db.prepare('INSERT OR REPLACE INTO segment_files(session_id, seq, path, kind, ops) VALUES (?, ?, ?, ?, ?)');
    const insFts = db.prepare('INSERT INTO segments_fts(session_id, seq, subject, body) VALUES (?, ?, ?, ?)');
    const note = db.prepare("SELECT what, why FROM commit_notes WHERE commit_sha = ? AND status = 'ok'");
    for (const s of segments) {
      insSeg.run(
        sessionId,
        s.seq,
        projectId,
        s.startedAt ?? null,
        s.endedAt ?? null,
        s.activeMin ?? 0,
        s.commit?.sha ?? null,
        s.commit?.subject ?? null,
        JSON.stringify(s.prompts ?? []),
      );
      for (const f of s.files ?? []) insFile.run(sessionId, s.seq, f.path, f.kind, f.ops ?? 1);
      const n = s.commit ? note.get(s.commit.sha) : null;
      const noteText = n ? [n.what, n.why] : [];
      insFts.run(
        sessionId,
        s.seq,
        foldText(s.commit?.subject ?? ''),
        foldText([...(s.prompts ?? []), ...(s.files ?? []).map((f) => f.path), ...noteText].join('\n')),
      );
    }
  }

  // --- file hints ---------------------------------------------------------------

  /** Mark a file as hinted in a session; false when it already was. */
  claimFileHint(sessionId, path) {
    return this.db.prepare('INSERT OR IGNORE INTO file_hints(session_id, path, shown_at) VALUES (?, ?, ?)').run(sessionId, path, new Date().toISOString()).changes > 0;
  }

  /**
   * Segments of *other* sessions that edited exactly `path`, newest first,
   * with their commit note and the rework verdicts of their session.
   */
  fileHistory(path, { projectId, excludeSessionId = null, limit = 3 }) {
    const rows = this.db
      .prepare(
        `${SEGMENT_SELECT} WHERE g.project_id = ? AND g.session_id != ?
           AND EXISTS (SELECT 1 FROM segment_files f WHERE f.session_id = g.session_id AND f.seq = g.seq AND f.path = ?)
         ORDER BY g.ended_at DESC, g.seq DESC LIMIT ?`,
      )
      .all(projectId, excludeSessionId ?? '', path, limit);
    const total = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM segment_files f JOIN segments g ON g.session_id = f.session_id AND g.seq = f.seq
         WHERE g.project_id = ? AND g.session_id != ? AND f.path = ?`,
      )
      .get(projectId, excludeSessionId ?? '', path).n;
    const rework = [];
    for (const sessionId of new Set(rows.map((r) => r.session_id))) {
      const d = parsedDetails(this.db.prepare('SELECT details FROM sessions WHERE id = ?').get(sessionId)?.details ?? '{}');
      for (const r of d.rework ?? []) if (r.path === path) rework.push({ ...r, sessionId });
    }
    return { rows, total, rework };
  }

  // --- commit notes -----------------------------------------------------------

  /** Notes by sha (status ok/skipped/failed), for the given shas. */
  notesFor(shas) {
    const q = this.db.prepare('SELECT * FROM commit_notes WHERE commit_sha = ?');
    const out = new Map();
    for (const sha of shas) {
      const n = q.get(sha);
      if (n) out.set(sha, n);
    }
    return out;
  }

  /**
   * Record the outcome of summarising one commit: 'ok' with a note, 'skipped'
   * (nothing to summarise), or 'failed' (counted, retried a limited number of times).
   */
  putNote({ sha, projectId, sessionId, status, type = null, what = null, why = null, error = null, model = null, costUsd = null }) {
    this.db
      .prepare(
        `INSERT INTO commit_notes(commit_sha, project_id, session_id, status, type, what, why, attempts, error, model, cost_usd, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
         ON CONFLICT(commit_sha) DO UPDATE SET status = excluded.status, type = excluded.type, what = excluded.what,
           why = excluded.why, attempts = commit_notes.attempts + 1, error = excluded.error, model = excluded.model,
           cost_usd = excluded.cost_usd, created_at = excluded.created_at`,
      )
      .run(sha, projectId, sessionId, status, type, what, why, error, model, costUsd, new Date().toISOString());
  }

  /** Rebuild one session's segment search rows, e.g. after notes arrived. */
  refreshSegmentIndex(sessionId) {
    const s = this.getSession(sessionId);
    if (!s || s.id !== sessionId) return;
    const segments = parsedDetails(s.details).segments ?? [];
    this.db.exec('BEGIN');
    try {
      this.#writeSegments(sessionId, s.project_id, segments);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Segments of one session in order, with their files. */
  sessionSegments(sessionId) {
    return this.#withFiles(this.db.prepare(`${SEGMENT_SELECT} WHERE g.session_id = ? ORDER BY g.seq`).all(sessionId));
  }

  /**
   * Most recent segments across sessions: the unit `recent` lists.
   * @param {{projectId?:string|null, limit?:number, since?:string|null, excludeSessionId?:string|null}} [opts]
   */
  recentSegments({ projectId = null, limit = 10, since = null, excludeSessionId = null, includeEmpty = false } = {}) {
    // A segment with no commit and no file changes is talk only ("where did we
    // stop?"): search still finds it, but it is not "recent work".
    const extra = includeEmpty ? [] : ['(g.commit_sha IS NOT NULL OR EXISTS (SELECT 1 FROM segment_files f WHERE f.session_id = g.session_id AND f.seq = g.seq))'];
    const { where, params } = segmentFilters({ projectId, since, excludeSessionId }, extra);
    const sql = `${SEGMENT_SELECT} ${where} ORDER BY g.ended_at DESC, g.seq DESC LIMIT ?`;
    return this.#withFiles(this.db.prepare(sql).all(...params, limit));
  }

  /**
   * Segments that edited a file matching `fragment`, newest first: "when did
   * we last touch X, and what came of it". Each row carries `matched` paths.
   */
  touched(fragment, { projectId = null, limit = 10, since = null } = {}) {
    const like = `%${String(fragment).replace(/\\/g, '/')}%`;
    const { where, params } = segmentFilters({ projectId, since }, ['EXISTS (SELECT 1 FROM segment_files f WHERE f.session_id = g.session_id AND f.seq = g.seq AND f.path LIKE ? COLLATE NOCASE)']);
    const rows = this.#withFiles(this.db.prepare(`${SEGMENT_SELECT} ${where} ORDER BY g.ended_at DESC, g.seq DESC LIMIT ?`).all(like, ...params, limit));
    const re = new RegExp(escapeRegExp(String(fragment).replace(/\\/g, '/')), 'i');
    for (const r of rows) r.matched = r.files.filter((f) => re.test(f.path));
    return rows;
  }

  /** Full-text search over segments (commit subject weighs most). */
  searchSegments(query, { projectId = null, limit = 10, since = null } = {}) {
    const terms = ftsTerms(query);
    if (!terms.length) return [];
    const run = (match) => {
      const { where, params } = segmentFilters({ projectId, since }, ['segments_fts MATCH ?']);
      return this.#withFiles(
        this.db
          .prepare(
            `SELECT g.*, s.branch, s.title, s.status, s.updated_at, n.type AS note_type, n.what AS note_what, n.why AS note_why,
               bm25(segments_fts, 0, 0, 10.0, 1.0) AS rank
             FROM segments_fts JOIN segments g ON g.session_id = segments_fts.session_id AND g.seq = segments_fts.seq
             JOIN sessions s ON s.id = g.session_id
             LEFT JOIN commit_notes n ON n.commit_sha = g.commit_sha AND n.status = 'ok'
             ${where} ORDER BY rank LIMIT ?`,
          )
          .all(match, ...params, limit),
      );
    };
    const strict = run(terms.join(' AND '));
    if (strict.length || terms.length === 1) return strict;
    return run(terms.join(' OR '));
  }

  /** The segment that ends with a commit whose sha starts with `prefix`. */
  segmentByCommit(prefix) {
    if (!/^[0-9a-f]{4,64}$/i.test(prefix)) return null;
    const row = this.db.prepare(`${SEGMENT_SELECT} WHERE g.commit_sha LIKE ? ORDER BY g.ended_at DESC LIMIT 1`).get(`${prefix.toLowerCase()}%`);
    return row ? this.#withFiles([row])[0] : null;
  }

  #withFiles(rows) {
    const q = this.db.prepare('SELECT path, kind, ops FROM segment_files WHERE session_id = ? AND seq = ? ORDER BY path');
    for (const r of rows) {
      r.files = q.all(r.session_id, r.seq);
      r.prompts = safeJson(r.prompts) ?? [];
    }
    return rows;
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
  recentSessions({ projectId = null, limit = 5, excludeId = null, since = null } = {}) {
    const where = [];
    const params = [];
    if (since) {
      where.push('updated_at >= ?');
      params.push(since);
    }
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

  /**
   * Sessions whose details predate `format` (written by an older version,
   * before segments existed): candidates for re-indexing.
   */
  sessionsOlderThan(format, limit = 1000) {
    return this.db
      .prepare(
        `SELECT id, project_id, cwd, status, end_reason, updated_at FROM sessions
         WHERE COALESCE(json_extract(details, '$.format'), 0) < ? ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(format, limit);
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
  search(query, { projectId = null, limit = 10, since = null } = {}) {
    const terms = ftsTerms(query);
    if (!terms.length) return [];
    const run = (match) => {
      const where = ['sessions_fts MATCH ?'];
      const params = [match];
      if (projectId) {
        where.push('s.project_id = ?');
        params.push(projectId);
      }
      if (since) {
        where.push('s.updated_at >= ?');
        params.push(since);
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
  searchByFile(fragment, { projectId = null, limit = 10, since = null } = {}) {
    const params = [`%${fragment.replace(/\\/g, '/')}%`];
    let sql = `SELECT DISTINCT s.* FROM session_files f JOIN sessions s ON s.id = f.session_id WHERE f.path LIKE ? COLLATE NOCASE`;
    if (projectId) {
      sql += ' AND s.project_id = ?';
      params.push(projectId);
    }
    if (since) {
      sql += ' AND s.updated_at >= ?';
      params.push(since);
    }
    sql += ' ORDER BY s.updated_at DESC LIMIT ?';
    return this.db.prepare(sql).all(...params, limit);
  }

  deleteSession(id) {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM sessions_fts WHERE session_id = ?').run(id);
      this.db.prepare('DELETE FROM segments_fts WHERE session_id = ?').run(id);
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
      this.db.prepare('DELETE FROM segments_fts WHERE session_id IN (SELECT id FROM sessions WHERE project_id = ?)').run(projectId);
      const r = this.db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
      this.db.exec('COMMIT');
      return r.changes;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
}

/** Segment rows joined with the session fields every listing shows. */
const SEGMENT_SELECT = `SELECT g.*, s.branch, s.title, s.status, s.updated_at, n.type AS note_type, n.what AS note_what, n.why AS note_why
  FROM segments g JOIN sessions s ON s.id = g.session_id
  LEFT JOIN commit_notes n ON n.commit_sha = g.commit_sha AND n.status = 'ok'`;

function segmentFilters({ projectId = null, since = null, excludeSessionId = null }, extra = []) {
  const where = [...extra];
  const params = [];
  if (projectId) {
    where.push('g.project_id = ?');
    params.push(projectId);
  }
  if (since) {
    where.push('g.ended_at >= ?');
    params.push(since);
  }
  if (excludeSessionId) {
    where.push('g.session_id != ?');
    params.push(excludeSessionId);
  }
  return { where: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}

function parsedDetails(details) {
  return typeof details === 'string' ? safeJson(details) : details ?? {};
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Text that goes into the FTS `body` column. */
function fulltextBody(details, files) {
  const d = typeof details === 'string' ? safeJson(details) : details ?? {};
  const chunks = [];
  for (const p of d.prompts ?? []) chunks.push(p.text);
  for (const f of files ?? []) chunks.push(f.path);
  for (const c of d.commands ?? []) chunks.push(c);
  for (const c of d.commits ?? []) chunks.push(`${c.sha} ${c.subject}`);
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
    .map((t) => `"${stem(t)}"*`);
}
