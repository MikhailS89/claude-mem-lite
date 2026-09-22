#!/usr/bin/env node
// Stop hook (end of every assistant turn): refresh this session's row from the
// transcript so that a crash or a killed terminal loses at most one turn.
// Runs async (see hooks.json) and never blocks.

import { captureSession } from '../src/capture.mjs';
import { runHook } from '../src/hook-io.mjs';
import { logDebug } from '../src/log.mjs';

await runHook('session-stop', (input) => {
  const result = captureSession(input, { final: false });
  if (result.skipped) logDebug('session-stop: skipped', result);
  return undefined;
});
