#!/usr/bin/env node
// Stands in for `claude -p` in tests: reads the prompt from stdin and answers
// in the shape of `--output-format json` with a structured_output.
// FAKE_CLAUDE_MODE: ok (default) | error | garbage | not-stated. FAKE_CLAUDE_LOG: append argv + env checks.

import { appendFileSync, readFileSync } from 'node:fs';

const input = readFileSync(0, 'utf8');
const mode = process.env.FAKE_CLAUDE_MODE || 'ok';
if (process.env.FAKE_CLAUDE_LOG) {
  appendFileSync(
    process.env.FAKE_CLAUDE_LOG,
    JSON.stringify({ argv: process.argv.slice(2), memLiteEnabled: process.env.CLAUDE_MEM_LITE_ENABLED, sessionVar: process.env.CLAUDE_CODE_SESSION_ID ?? null, input }) + '\n',
  );
}
if (mode === 'error') {
  process.stderr.write('boom');
  process.exit(3);
}
if (mode === 'garbage') {
  process.stdout.write('not json');
  process.exit(0);
}
const subject = /^Commit: \S+ (.*)$/m.exec(input)?.[1] ?? '?';
const why = mode === 'not-stated' ? 'not stated' : `because of ${subject}`;
process.stdout.write(JSON.stringify({ is_error: false, total_cost_usd: 0.001, structured_output: { type: 'feature', what: `did ${subject}`, why } }));
