#!/usr/bin/env node
// SessionStart hook: print a short recap of previous sessions in this project
// as `additionalContext`. Prints nothing when there is nothing to recall.

import { runHook } from '../src/hook-io.mjs';
import { buildRecall } from '../src/recall.mjs';

await runHook('session-start', (input) => {
  const context = buildRecall(input);
  if (!context) return undefined;
  return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } };
});
