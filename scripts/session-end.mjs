#!/usr/bin/env node
// SessionEnd hook: final capture, marks the session as ended. With
// CLAUDE_MEM_LITE_LLM_SUMMARY on, also starts the notes worker for commits made
// in the last turn (it runs on after Claude Code has exited).

import { captureSession } from '../src/capture.mjs';
import { llmSummary } from '../src/config.mjs';
import { MemoryDb } from '../src/db.mjs';
import { runHook } from '../src/hook-io.mjs';
import { logDebug, logError } from '../src/log.mjs';
import { startNotesWorker } from '../src/notes.mjs';

await runHook('session-end', (input) => {
  const result = captureSession(input, { final: true });
  if (result.skipped) {
    logDebug('session-end: skipped', result);
    return undefined;
  }
  if (llmSummary) {
    try {
      const db = new MemoryDb();
      try {
        startNotesWorker(db, { sessionId: input.session_id, transcriptPath: input.transcript_path });
      } finally {
        db.close();
      }
    } catch (err) {
      logError('session-end: notes worker failed to start', err);
    }
  }
  return undefined;
});
