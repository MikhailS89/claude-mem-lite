// Builders for synthetic transcript lines, mirroring the real JSONL shape.

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

/**
 * Write a commit as a loose object, byte-for-byte the way git does.
 * @returns {string} the commit sha
 */
export function writeLooseCommit(gitDir, { parent = null, subject, time, body = '', extraHeader = '' }) {
  const who = `Test <t@example.com> ${Math.floor(time / 1000)} +0400`;
  const text =
    `tree ${'4b825dc642cb6eb9a060e54bf8d69288fbee4904'}\n` +
    (parent ? `parent ${parent}\n` : '') +
    `author ${who}\ncommitter ${who}\n${extraHeader}\n${subject}\n${body ? `\n${body}\n` : ''}`;
  const content = Buffer.from(text, 'utf8');
  const raw = Buffer.concat([Buffer.from(`commit ${content.length}\0`), content]);
  const sha = createHash('sha1').update(raw).digest('hex');
  mkdirSync(join(gitDir, 'objects', sha.slice(0, 2)), { recursive: true });
  writeFileSync(join(gitDir, 'objects', sha.slice(0, 2), sha.slice(2)), deflateSync(raw));
  return sha;
}

let counter = 0;
const base = Date.parse('2026-09-21T09:00:00Z');

function stamp() {
  return new Date(base + counter++ * 60_000).toISOString();
}

const common = (sessionId, cwd) => ({ sessionId, cwd, gitBranch: 'main', version: '2.1.278', userType: 'external' });

export function userPrompt(text, { sessionId = 'sess-1', cwd = 'C:\\proj', isMeta = false, sidechain = false } = {}) {
  return {
    ...common(sessionId, cwd),
    type: 'user',
    isSidechain: sidechain,
    isMeta,
    uuid: `u${counter}`,
    timestamp: stamp(),
    message: { role: 'user', content: Array.isArray(text) ? text : [{ type: 'text', text }] },
  };
}

export function assistantText(text, opts = {}) {
  return assistantBlocks([{ type: 'text', text }], opts);
}

export function toolUse(name, input, opts = {}) {
  return assistantBlocks([{ type: 'tool_use', id: `toolu_${counter}`, name, input }], opts);
}

export function assistantBlocks(content, { sessionId = 'sess-1', cwd = 'C:\\proj', sidechain = false } = {}) {
  return {
    ...common(sessionId, cwd),
    type: 'assistant',
    isSidechain: sidechain,
    uuid: `a${counter}`,
    timestamp: stamp(),
    message: { role: 'assistant', model: 'claude-opus-5', content },
  };
}

export function toolResult(toolUseId = 'toolu_x', content = 'ok', opts = {}) {
  return userPrompt([{ type: 'tool_result', tool_use_id: toolUseId, content }], opts);
}

export function aiTitle(title, sessionId = 'sess-1') {
  return { type: 'ai-title', aiTitle: title, sessionId };
}

export function toJsonl(records) {
  return records.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

/** A realistic little session: prompt, read, edit, bash, answer. */
export function sampleSession(overrides = {}) {
  const o = { sessionId: 'sess-1', cwd: 'C:\\proj', ...overrides };
  const f = (rel) => `${o.cwd}\\${rel}`;
  return [
    { type: 'queue-operation', operation: 'enqueue', sessionId: o.sessionId },
    userPrompt('Fix the login bug in the auth module', o),
    userPrompt([{ type: 'text', text: '<system-reminder>ignore me</system-reminder>' }, { type: 'text', text: 'Also add a test' }], o),
    aiTitle('Login bug fix', o.sessionId),
    toolUse('Read', { file_path: f('src\\auth.ts') }, o),
    toolResult('toolu_1', 'file contents', o),
    toolUse('Edit', { file_path: f('src\\auth.ts'), old_string: 'a', new_string: 'b' }, o),
    toolUse('Write', { file_path: f('test\\auth.test.ts'), content: 'test' }, o),
    toolUse('Read', { file_path: f('.env') }, o),
    toolUse('Bash', { command: `cd "${o.cwd}" && npm test` }, o),
    toolUse('Bash', { command: 'git commit -m "fix login" && echo TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789' }, o),
    toolUse('Grep', { pattern: 'validateToken' }, o),
    toolUse('Read', { file_path: f('src\\hidden.ts') }, { ...o, sidechain: true }),
    userPrompt('<local-command-caveat>slash command output</local-command-caveat>', { ...o, isMeta: true }),
    assistantText('Fixed the null check in validateToken and added a regression test. <private>my secret note</private>', o),
    userPrompt('Thanks, also update the docs', o),
    assistantText('Docs updated in README.md.', o),
  ];
}

/** A Bash call plus its result, linked by tool_use id as in real transcripts. */
export function bash(command, output, { isError = false, ...opts } = {}) {
  const id = `toolu_bash_${counter}`;
  return [
    assistantBlocks([{ type: 'tool_use', id, name: 'Bash', input: { command } }], opts),
    userPrompt([{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: output }], is_error: isError }], opts),
  ];
}

/** A session that commits twice, amends, fails one commit and keeps editing afterwards. */
export function commitSession(overrides = {}) {
  const o = { sessionId: 'sess-c', cwd: 'C:\\proj', ...overrides };
  const f = (rel) => `${o.cwd}\\${rel}`;
  return [
    userPrompt('Implement stage 1', o),
    toolUse('Edit', { file_path: f('src\\a.ts'), old_string: 'a', new_string: 'b' }, o),
    toolUse('Edit', { file_path: f('docs\\ARCHITECTURE.md'), old_string: 'a', new_string: 'b' }, o),
    ...bash('git add -A && git commit -m "feat: stage 0 skeleton"', '[main (root-commit) 1111111] feat: stage 0 skeleton\n 2 files changed', o),
    toolUse('Edit', { file_path: f('src\\b.ts'), old_string: 'a', new_string: 'b' }, o),
    ...bash('git commit -am "feat: stage 1 content modle"', '[main 2222222] feat: stage 1 content modle\n 1 file changed', o),
    ...bash('git commit --amend -m "feat: stage 1 content model"', '[main 3333333] feat: stage 1 content model\n Date: now', o),
    ...bash('git commit -m "wip"', 'pre-commit hook failed\n[main 4444444] wip', { ...o, isError: true }),
    ...bash('cat notes.txt', '[main 5555555] not a real commit', o),
    toolUse('Write', { file_path: f('README.md'), content: 'x' }, o),
    toolUse('Edit', { file_path: f('.env'), old_string: 'a', new_string: 'b' }, o),
    assistantText('## Done\n\nStage 1 is **committed**. Next: `stage 2`.\n\n| a | b |\n|---|---|\n\n```js\ncode()\n```', o),
  ];
}
