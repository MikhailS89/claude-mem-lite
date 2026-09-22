#!/usr/bin/env node
// SessionEnd hook: final capture, marks the session as ended.

import { captureSession } from '../src/capture.mjs';
import { runHook } from '../src/hook-io.mjs';
import { logDebug } from '../src/log.mjs';

await runHook('session-end', (input) => {
  const result = captureSession(input, { final: true });
  if (result.skipped) logDebug('session-end: skipped', result);
  return undefined;
});
