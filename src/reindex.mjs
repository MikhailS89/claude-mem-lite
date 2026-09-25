// Re-indexing: bring rows written by older versions (no segments, activity
// counters instead of state) up to the current format, from their transcripts.
//
// Claude Code keeps transcripts under <config dir>/projects/<dir>/<session>.jsonl
// for a limited time (30 days by default), so a row can be rebuilt only while
// its transcript exists. Rows whose transcript is gone stay as they are and are
// shown as "legacy" in the recap.
//
// The Stop hook calls reindexSome() with a small budget after every turn, so an
// upgrade converts the whole database within a few turns without ever making
// one hook run long; `search.mjs reindex` does the same in one go.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildSessionRecord } from './capture.mjs';
import { logDebug, logError } from './log.mjs';
import { DETAILS_FORMAT } from './summarize.mjs';

/** Set once every old row has been tried, so later hook runs skip the scan. */
const DONE_KEY = `reindexed_format_${DETAILS_FORMAT}`;

/** Where Claude Code keeps transcripts; honours CLAUDE_CONFIG_DIR. */
export function transcriptRoots(env = process.env) {
  const base = env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  return [join(base, 'projects')];
}

/** Find `<sessionId>.jsonl` in any project directory under the transcript roots. */
export function findTranscript(sessionId, roots = transcriptRoots()) {
  for (const root of roots) {
    let dirs = [];
    try {
      dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      continue;
    }
    for (const d of dirs) {
      const p = join(root, d.name, `${sessionId}.jsonl`);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

/** Every top-level `<sessionId>.jsonl` under the transcript roots (subagent files live deeper). */
export function listTranscripts(roots = transcriptRoots()) {
  const out = [];
  for (const root of roots) {
    let dirs = [];
    try {
      dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      continue;
    }
    for (const d of dirs) {
      let files = [];
      try {
        files = readdirSync(join(root, d.name), { withFileTypes: true }).filter((f) => f.isFile() && f.name.endsWith('.jsonl'));
      } catch {
        continue;
      }
      for (const f of files) {
        const path = join(root, d.name, f.name);
        let mtimeMs = 0;
        try {
          mtimeMs = statSync(path).mtimeMs;
        } catch {}
        out.push({ id: f.name.slice(0, -'.jsonl'.length), path, mtimeMs });
      }
    }
  }
  return out;
}

/**
 * Re-index up to `budget` old rows.
 * @param {import('./db.mjs').MemoryDb} db
 * @returns {{rebuilt: number, missing: number, remaining: number, done: boolean}}
 */
export function reindexSome(db, { budget = 5, roots = transcriptRoots(), force = false } = {}) {
  if (!force && db.getMeta(DONE_KEY)) return { rebuilt: 0, missing: 0, remaining: 0, done: true };
  // Rows whose transcript was not found are not retried on every hook run;
  // an explicit `reindex` (force) tries them again.
  const skipped = new Set(force ? [] : JSON.parse(db.getMeta(`${DONE_KEY}_missing`) ?? '[]'));
  const pending = db.sessionsOlderThan(DETAILS_FORMAT).filter((s) => !skipped.has(s.id));
  let rebuilt = 0;
  let missing = 0;
  for (const s of pending.slice(0, budget)) {
    const transcriptPath = findTranscript(s.id, roots);
    let record = null;
    try {
      record = transcriptPath
        ? buildSessionRecord({ sessionId: s.id, transcriptPath, cwd: s.cwd ?? process.cwd(), live: false, final: s.status === 'ended', endReason: s.end_reason })
        : null;
    } catch (err) {
      logError('reindex: failed', err);
    }
    if (!record) {
      skipped.add(s.id);
      missing++;
      continue;
    }
    // Keep the row's identity, lifecycle and place in "most recent" order;
    // only its content is rebuilt.
    record.row.projectId = s.project_id;
    record.row.updatedAt = s.updated_at;
    db.upsertSession(record.row, record.files);
    rebuilt++;
  }
  db.setMeta(`${DONE_KEY}_missing`, JSON.stringify([...skipped]));
  const remaining = Math.max(0, pending.length - rebuilt - missing);
  if (remaining === 0) db.setMeta(DONE_KEY, new Date().toISOString());
  if (rebuilt || missing) logDebug('reindex', { rebuilt, missing, remaining });
  return { rebuilt, missing, remaining, done: remaining === 0 };
}
