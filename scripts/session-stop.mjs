#!/usr/bin/env node
// Stop hook (end of every assistant turn): refresh this session's row from the
// transcript so that a crash or a killed terminal loses at most one turn.
// Runs async (see hooks.json) and never blocks.
//
// Afterwards, with the same database handle:
//   - re-index a few rows written by older versions (see reindex.mjs);
//   - with CLAUDE_MEM_LITE_LLM_SUMMARY on, start the background worker that
//     writes "what / why" notes for new commits (see notes.mjs).

import { captureSession } from '../src/capture.mjs';
import { llmSummary } from '../src/config.mjs';
import { MemoryDb } from '../src/db.mjs';
import { runHook } from '../src/hook-io.mjs';
import { logDebug, logError } from '../src/log.mjs';
import { startNotesWorker } from '../src/notes.mjs';
import { reindexSome } from '../src/reindex.mjs';

/** Old rows re-indexed per turn: keeps every hook run short. */
const REINDEX_BUDGET = 5;

await runHook('session-stop', (input) => {
  const result = captureSession(input, { final: false });
  if (result.skipped) {
    logDebug('session-stop: skipped', result);
    return undefined;
  }
  try {
    const db = new MemoryDb();
    try {
      if (llmSummary) startNotesWorker(db, { sessionId: input.session_id, transcriptPath: input.transcript_path });
      reindexSome(db, { budget: REINDEX_BUDGET });
    } finally {
      db.close();
    }
  } catch (err) {
    logError('session-stop: follow-up failed', err);
  }
  return undefined;
});
