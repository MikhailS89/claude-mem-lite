// Turning a session's commits into notes ("what" and "why") in the
// background. The Stop hook only starts a short-lived worker process
// (scripts/notes-worker.mjs) when there are commits without a note; the worker
// summarises them one by one (llm.mjs), stores the notes and exits. Model calls
// take seconds, far too long for a hook, and a separate process also survives
// Claude Code stopping the hook early (claude -p).

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { llmModel } from './config.mjs';
import { buildInput, summarizeCommit } from './llm.mjs';
import { logDebug, logError } from './log.mjs';
import { parseTranscriptFile } from './transcript.mjs';

const WORKER = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'notes-worker.mjs');

/** A failed commit is retried this many times in total, then left alone. */
const MAX_ATTEMPTS = 2;
/** Commits summarised per worker run: bounds the cost of one run. */
export const NOTES_BUDGET = 10;
/** A lock older than this belongs to a worker that died; ignore it. */
const LOCK_TTL_MS = 10 * 60 * 1000;

/** Committed segments of a session that still need a note. */
export function pendingCommits(db, sessionId) {
  const s = db.getSession(sessionId);
  if (!s || s.id !== sessionId) return [];
  let details;
  try {
    details = JSON.parse(s.details);
  } catch {
    return [];
  }
  const committed = (details.segments ?? []).filter((g) => g.commit);
  const notes = db.notesFor(committed.map((g) => g.commit.sha));
  return committed
    .filter((g) => {
      const n = notes.get(g.commit.sha);
      return !n || (n.status === 'failed' && n.attempts < MAX_ATTEMPTS);
    })
    .map((g) => ({ ...g, projectId: s.project_id }));
}

/**
 * Summarise pending commits of one session. `call` is the model call
 * (injectable for tests). Newest commits first: they matter most.
 * @returns {{done: number, skipped: number, failed: number, locked?: boolean}}
 */
export function summarizePending(db, { sessionId, transcriptPath, budget = NOTES_BUDGET, call = summarizeCommit, now = Date.now() }) {
  const lockKey = `notes_lock:${sessionId}`;
  const held = Date.parse(db.getMeta(lockKey) ?? '');
  if (Number.isFinite(held) && now - held < LOCK_TTL_MS) return { done: 0, skipped: 0, failed: 0, locked: true };
  db.setMeta(lockKey, new Date(now).toISOString());
  const result = { done: 0, skipped: 0, failed: 0 };
  try {
    const pending = pendingCommits(db, sessionId).reverse().slice(0, budget);
    if (!pending.length) return result;
    let texts = [];
    try {
      if (transcriptPath && existsSync(transcriptPath)) texts = parseTranscriptFile(transcriptPath).assistantTexts;
    } catch (err) {
      logError('notes: transcript unreadable', err);
    }
    for (const g of pending) {
      const from = Date.parse(g.startedAt ?? '') || -Infinity;
      const to = Date.parse(g.endedAt ?? '') || Infinity;
      const said = texts.filter((t) => {
        const ms = Date.parse(t.ts);
        return ms > from && ms <= to;
      }).map((t) => t.text);
      const input = buildInput(g, said);
      const base = { sha: g.commit.sha, projectId: g.projectId, sessionId };
      if (!input) {
        db.putNote({ ...base, status: 'skipped' });
        result.skipped++;
        continue;
      }
      const r = call(input);
      if (r.ok) {
        db.putNote({ ...base, status: 'ok', ...r.note, model: llmModel, costUsd: r.costUsd });
        result.done++;
      } else {
        db.putNote({ ...base, status: 'failed', error: r.error });
        result.failed++;
        logError('notes: summary failed', new Error(`${g.commit.sha.slice(0, 7)}: ${r.error}`));
      }
    }
    if (result.done) db.refreshSegmentIndex(sessionId);
    return result;
  } finally {
    db.setMeta(lockKey, '');
  }
}

/**
 * Start the worker for a session if it has commits without a note. Returns
 * immediately; the worker outlives the hook.
 * @returns {boolean} whether a worker was started
 */
export function startNotesWorker(db, { sessionId, transcriptPath }) {
  if (!pendingCommits(db, sessionId).length) return false;
  try {
    const child = spawn(process.execPath, ['--no-warnings', WORKER, sessionId, transcriptPath ?? ''], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    logDebug('notes: worker started', { sessionId, pid: child.pid });
    return true;
  } catch (err) {
    logError('notes: could not start worker', err);
    return false;
  }
}
