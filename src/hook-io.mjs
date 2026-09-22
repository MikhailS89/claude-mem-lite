// Reading hook input from stdin and running a hook body safely.
// Claude Code passes a JSON object on stdin (session_id, cwd, transcript_path,
// hook_event_name, ...). See https://code.claude.com/docs/en/hooks

import { logDebug, logError } from './log.mjs';

/** Read the whole stdin and parse it as JSON. Returns {} when nothing arrives. */
export async function readHookInput() {
  // Running the script by hand in a terminal: don't hang waiting for input.
  if (process.stdin.isTTY) return {};
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  data = data.trim();
  if (!data) return {};
  return JSON.parse(data);
}

/**
 * Run a hook body. Whatever happens we exit 0: this plugin only observes and
 * must never block a tool call, a prompt, or the session itself.
 * `body` may return a JSON-serialisable object which is printed to stdout
 * (this is how SessionStart returns `additionalContext`).
 */
export async function runHook(name, body) {
  let output;
  try {
    const input = await readHookInput();
    logDebug(`${name}: input`, { session_id: input.session_id, cwd: input.cwd, event: input.hook_event_name });
    output = await body(input);
  } catch (err) {
    logError(`${name}: failed`, err);
  }
  if (output !== undefined) process.stdout.write(JSON.stringify(output));
  process.exitCode = 0;
}
