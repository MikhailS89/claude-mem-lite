#!/usr/bin/env node
// Stop hook (end of every assistant turn): refresh this session's row from the
// transcript so that a crash or a killed terminal loses at most one turn.
// Runs async (see hooks.json) and never blocks.
//
// After an upgrade it also re-indexes a few rows written by older versions
// per turn (see reindex.mjs), until none are left.

import { captureSession } from '../src/capture.mjs';
import { MemoryDb } from '../src/db.mjs';
import { runHook } from '../src/hook-io.mjs';
import { logDebug, logError } from '../src/log.mjs';
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
      reindexSome(db, { budget: REINDEX_BUDGET });
    } finally {
      db.close();
    }
  } catch (err) {
    logError('session-stop: reindex failed', err);
  }
  return undefined;
});
