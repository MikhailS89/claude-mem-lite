#!/usr/bin/env node
// PostToolUse hook on Read / Edit / Write / NotebookEdit: the first time Claude
// touches a file in a session, add that file's history from earlier sessions
// to its context (see src/hints.mjs). Synchronous, so the hint arrives with
// the tool result; prints nothing - and costs only a Node start - otherwise.

import { runHook } from '../src/hook-io.mjs';
import { fileHint } from '../src/hints.mjs';

await runHook('file-hint', (input) => {
  const hint = fileHint(input);
  if (!hint) return undefined;
  return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: hint } };
});
