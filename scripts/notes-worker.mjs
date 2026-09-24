#!/usr/bin/env node
// Background worker started by the Stop / SessionEnd hooks (see src/notes.mjs):
// summarise one session's commits that have no note yet, then exit.
//
//   notes-worker.mjs <session-id> <transcript-path>

import { enabled, llmSummary } from '../src/config.mjs';
import { MemoryDb } from '../src/db.mjs';
import { logDebug, logError } from '../src/log.mjs';
import { summarizePending } from '../src/notes.mjs';

const [sessionId, transcriptPath] = process.argv.slice(2);

if (enabled && llmSummary && sessionId) {
  try {
    const db = new MemoryDb();
    try {
      const r = summarizePending(db, { sessionId, transcriptPath: transcriptPath || null });
      logDebug('notes: worker finished', { sessionId, ...r });
    } finally {
      db.close();
    }
  } catch (err) {
    logError('notes: worker failed', err);
  }
}
process.exitCode = 0;
