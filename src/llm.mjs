// Commit summaries by a small model, through the user's own Claude Code.
//
// One call per commit (not per tool call): the input is the conversation in
// that commit's window - the user's prompts and Claude's own explanations -
// plus the commit subject and its files. The reason for a change is usually
// stated there in so many words; the model's job is to find it, not to guess
// it from tool calls.
//
// The call is `claude -p` with no tools, no session persistence (it never
// shows up in --resume), no settings sources (none of the user's hooks run)
// and this plugin disabled in the child's environment, so it cannot record
// itself. Nothing here runs unless CLAUDE_MEM_LITE_LLM_SUMMARY is on.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeBin, llmModel } from './config.mjs';
import { sanitize, truncate } from './privacy.mjs';

export const NOTE_TYPES = ['feature', 'fix', 'refactor', 'docs', 'test', 'chore', 'decision', 'revert'];

const SCHEMA = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: NOTE_TYPES },
    what: { type: 'string' },
    why: { type: 'string' },
  },
  required: ['type', 'what', 'why'],
};

const SYSTEM_PROMPT = [
  'You summarise one unit of software work (the work that ended in one git commit) for a developer memory.',
  'Reply only through the JSON schema.',
  '"what": one sentence, what changed. Be concrete: name files, rules, services.',
  '"why": one sentence, the reason as stated in the conversation. If no reason was stated, write exactly "not stated". Never invent one.',
  'Write "what" and "why" in the same language as the lines under "User asked".',
].join(' ');

/** Characters of conversation sent per commit; the rest is cut from the middle. */
const INPUT_CHARS = 6000;
const CALL_TIMEOUT_MS = 90_000;

/** Variables of the parent session that must not leak into the child. */
const PARENT_VARS = ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_ENV_FILE', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_PROJECT_DIR'];

/**
 * The `claude` executable: an explicit setting, the one running this hook
 * (Claude Code tells hooks its own path), `claude` on PATH, or the newest
 * copy bundled with the VS Code extension.
 * @returns {string|null}
 */
export function findClaude(env = process.env, home = homedir()) {
  if (claudeBin) return claudeBin;
  if (env.CLAUDE_CODE_EXECPATH && existsSync(env.CLAUDE_CODE_EXECPATH)) return env.CLAUDE_CODE_EXECPATH;
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  for (const dir of (env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    if (dir && existsSync(join(dir, exe))) return join(dir, exe);
  }
  for (const ext of ['.vscode', '.vscode-insiders', '.cursor']) {
    const root = join(home, ext, 'extensions');
    let dirs = [];
    try {
      dirs = readdirSync(root).filter((d) => d.startsWith('anthropic.claude-code-'));
    } catch {
      continue;
    }
    const found = dirs
      .map((d) => join(root, d, 'resources', 'native-binary', exe))
      .filter((p) => existsSync(p))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
    if (found) return found;
  }
  return null;
}

/**
 * The text sent to the model for one committed segment, or null when the
 * window holds no conversation (then there is no stated reason to find).
 * @param {{commit:{sha:string, subject:string}, files:{path:string, ops:number}[], prompts:string[]}} segment
 * @param {string[]} said  Claude's own messages in the segment's window
 */
export function buildInput(segment, said) {
  const prompts = (segment.prompts ?? []).map((p) => sanitize(p)).filter(Boolean);
  const answers = said.map((t) => truncate(sanitize(t), 800)).filter(Boolean);
  if (!prompts.length && !answers.length) return null;
  const files = (segment.files ?? []).slice(0, 20).map((f) => `${f.path}${f.ops > 1 ? ` (${f.ops} edits)` : ''}`);
  const head = [`Commit: ${segment.commit.sha.slice(0, 7)} ${segment.commit.subject}`, `Files: ${files.join(', ') || '-'}`];
  let body = [...(prompts.length ? ['User asked:', ...prompts.map((p) => `- ${p}`)] : []), ...(answers.length ? ['Assistant said:', ...answers.map((a) => `- ${a}`)] : [])].join('\n');
  if (body.length > INPUT_CHARS) body = `${body.slice(0, INPUT_CHARS / 2)}\n[…]\n${body.slice(-INPUT_CHARS / 2)}`;
  return `${head.join('\n')}\n${body}`;
}

/**
 * Ask the model for {type, what, why}. Never throws.
 * @returns {{ok: true, note: {type:string, what:string, why:string}, costUsd: number|null} | {ok: false, error: string}}
 */
export function summarizeCommit(input, { bin = findClaude(), model = llmModel, timeoutMs = CALL_TIMEOUT_MS } = {}) {
  if (!bin) return { ok: false, error: 'claude executable not found (set CLAUDE_MEM_LITE_CLAUDE_BIN)' };
  const env = { ...process.env, CLAUDE_MEM_LITE_ENABLED: 'false' };
  for (const k of PARENT_VARS) delete env[k];
  const args = [
    '-p',
    '--model', model,
    '--tools', '',
    '--no-session-persistence',
    '--output-format', 'json',
    '--json-schema', JSON.stringify(SCHEMA),
    '--system-prompt', SYSTEM_PROMPT,
    '--setting-sources', '',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--effort', 'low',
  ];
  // A script path (tests, wrappers) runs under this Node.
  const [cmd, argv] = /\.(m?js|cjs)$/i.test(bin) ? [process.execPath, [bin, ...args]] : [bin, args];
  let r;
  try {
    r = spawnSync(cmd, argv, { input, encoding: 'utf8', env, cwd: tmpdir(), timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
  if (r.error) return { ok: false, error: r.error.code === 'ETIMEDOUT' ? 'timed out' : r.error.message };
  if (r.status !== 0) return { ok: false, error: `exit ${r.status}: ${truncate(r.stderr || r.stdout || '', 200)}` };
  let out;
  try {
    out = JSON.parse(r.stdout);
  } catch {
    return { ok: false, error: 'unparseable output' };
  }
  if (out.is_error) return { ok: false, error: truncate(String(out.result ?? out.subtype ?? 'error'), 200) };
  const note = out.structured_output;
  if (!note || !NOTE_TYPES.includes(note.type) || typeof note.what !== 'string' || typeof note.why !== 'string') {
    return { ok: false, error: 'output does not match the schema' };
  }
  return {
    ok: true,
    note: { type: note.type, what: truncate(sanitize(note.what), 300), why: truncate(sanitize(note.why), 300) },
    costUsd: typeof out.total_cost_usd === 'number' ? out.total_cost_usd : null,
  };
}
