// Reading hook input from stdin and running a hook body safely.
// Claude Code passes a JSON object on stdin (session_id, cwd, transcript_path,
// hook_event_name, ...). See https://code.claude.com/docs/en/hooks

import { logDebug, logError } from './log.mjs';

/** Give up waiting for stdin after this long; the hook then does nothing. */
const STDIN_TIMEOUT_MS = 5000;

/**
 * Read the hook's JSON input from stdin. Resolves as soon as a complete JSON
 * object has arrived instead of waiting for end-of-stream: Claude Code does
 * not promise to close stdin, and a hook that waits for EOF would then hang
 * until its timeout (losing the recap on SessionStart). Returns {} when
 * nothing arrives; throws on malformed input.
 */
export function readHookInput(stream = process.stdin, timeoutMs = STDIN_TIMEOUT_MS) {
  // Running the script by hand in a terminal: don't hang waiting for input.
  if (stream.isTTY) return Promise.resolve({});
  return new Promise((resolve, reject) => {
    let data = '';
    const finish = (fn, value) => {
      clearTimeout(timer);
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('error', onError);
      stream.destroy(); // an open stdin would otherwise keep the process alive
      fn(value);
    };
    const tryParse = () => {
      const text = data.trim();
      if (!text) return undefined;
      try {
        return JSON.parse(text);
      } catch {
        return undefined; // incomplete so far
      }
    };
    const onData = (chunk) => {
      data += chunk;
      const value = tryParse();
      if (value !== undefined) finish(resolve, value);
    };
    const onEnd = () => {
      if (!data.trim()) return finish(resolve, {});
      const value = tryParse();
      if (value === undefined) finish(reject, new Error(`malformed hook input: ${data.slice(0, 100)}`));
      else finish(resolve, value);
    };
    const onError = (err) => finish(reject, err);
    const timer = setTimeout(() => {
      if (!data.trim()) finish(resolve, {});
      else finish(reject, new Error(`incomplete hook input after ${timeoutMs} ms`));
    }, timeoutMs);
    stream.setEncoding('utf8');
    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
  });
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
