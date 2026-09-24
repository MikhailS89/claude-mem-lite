import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { MemoryDb } from '../src/db.mjs';
import { fileHint, formatHint } from '../src/hints.mjs';
import { resolveProject } from '../src/project.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'cml-hints-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
const repo = join(tmp, 'repo');
mkdirSync(join(repo, '.git'), { recursive: true });
const project = resolveProject(repo);

const seg = (seq, sha, subject, endedAt, files) => ({
  seq,
  startedAt: null,
  endedAt,
  activeMin: 3,
  commit: sha ? { sha, subject } : null,
  files: files.map((path) => ({ path, kind: 'edit', ops: 1 })),
  prompts: [],
});

function seeded() {
  const db = new MemoryDb(':memory:');
  db.upsertProject(project);
  const session = (id, segments, rework = []) =>
    db.upsertSession({ id, projectId: project.id, title: id, summary: '', details: { format: 3, segments, rework }, status: 'ended' }, []);
  session('old-1', [seg(0, 'aaaaaaa', 'feat: names dictionary', '2026-09-20T10:00:00Z', ['src/names.cjs', 'README.md'])]);
  session(
    'old-2',
    [seg(0, 'bbbbbbb', 'fix: transliteration rule', '2026-09-22T10:00:00Z', ['src/names.cjs']), seg(1, null, null, '2026-09-22T11:00:00Z', ['src/names.cjs'])],
    [{ path: 'src/names.cjs', reason: 'revisited', segments: [0, 2], edits: 9 }],
  );
  db.putNote({ sha: 'bbbbbbb', projectId: project.id, sessionId: 'old-2', status: 'ok', type: 'fix', what: 'w', why: 'brands stay in Latin script' });
  return db;
}

const input = (path, extra = {}) => ({ session_id: 'now', cwd: repo, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: join(repo, path) }, ...extra });

test('the first touch of a file with history gets its latest changes, why, and rework', () => {
  const db = seeded();
  const hint = fileHint(input('src/names.cjs'), { db });
  assert.equal(
    hint,
    [
      'claude-mem-lite: src/names.cjs in earlier sessions (3 changes):',
      '- 2026-09-22 left uncommitted',
      '- 2026-09-22 bbbbbbb fix: transliteration rule - why: brands stay in Latin script',
      '- 2026-09-20 aaaaaaa feat: names dictionary',
      '- revisited after moving on (9 edits in 2 segments) in session old-2',
    ].join('\n'),
  );
  assert.equal(fileHint(input('src/names.cjs'), { db }), null, 'once per file per session');
  assert.match(fileHint(input('src/names.cjs', { session_id: 'another' }), { db }), /3 changes/, 'again in a new session');
});

test('no hint for files without history, outside the project, secrets, other tools, or the same session', () => {
  const db = seeded();
  assert.equal(fileHint(input('src/new.ts'), { db }), null);
  assert.equal(fileHint({ ...input('x'), tool_input: { file_path: join(tmp, 'elsewhere', 'README.md') } }, { db }), null);
  assert.equal(fileHint(input('.env'), { db }), null);
  assert.equal(fileHint(input('src/names.cjs', { tool_name: 'Bash', tool_input: { command: 'cat src/names.cjs' } }), { db }), null);
  assert.equal(fileHint(input('src/names.cjs', { session_id: 'old-2' }), { db }).includes('old-2'), false, "a session's own work is never shown back to it");
  assert.equal(fileHint(input('src/names.cjs', { session_id: 's9', agent_id: 'a1' }), { db }), null, 'not inside subagents');
});

test('a shell command that reads files with cat or sed gets a hint per file with history', () => {
  const db = seeded();
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'names.cjs'), 'x');
  writeFileSync(join(repo, 'README.md'), 'x');
  writeFileSync(join(repo, 'src', 'fresh.ts'), 'x');
  const bash = (command, session = 'shell') => fileHint({ session_id: session, cwd: repo, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command } }, { db });
  const hint = bash(`cd "${repo}" && sed -n '1,20p' src/names.cjs && cat README.md src/fresh.ts | head -3`);
  assert.match(hint, /^claude-mem-lite: src\/names\.cjs in earlier sessions \(3 changes\):/);
  assert.match(hint, /\n\nclaude-mem-lite: README\.md in earlier sessions \(1 change\):\n- 2026-09-20 aaaaaaa feat: names dictionary$/);
  assert.doesNotMatch(hint, /fresh/, 'no history, no hint');
  assert.equal(bash('cat src/names.cjs'), null, 'already shown in this session');
  assert.equal(bash('npm test', 'other'), null);
});

test('edits that never reached a commit are not worth a hint, unless the work did not settle', () => {
  const db = seeded();
  const add = (id, rework = []) =>
    db.upsertSession({ id, projectId: project.id, title: id, summary: '', details: { format: 3, segments: [seg(0, null, null, '2026-09-19T10:00:00Z', ['docs/notes.md', 'src/tried.ts'])], rework }, status: 'ended' }, []);
  add('talk', [{ path: 'src/tried.ts', reason: 'deleted', segments: [0], edits: 2 }]);
  assert.equal(fileHint(input('docs/notes.md'), { db }), null);
  assert.match(fileHint(input('src/tried.ts'), { db }), /no commit recorded\n- created, then deleted in session talk/);
});

test('a hint names the path to dig further when there is more history than shown', () => {
  const rows = Array.from({ length: 3 }, (_, i) => ({ seq: 0, commit_sha: `${i}`.repeat(7), commit_subject: `c${i}`, ended_at: '2026-09-20T10:00:00Z' }));
  assert.match(formatHint('a.ts', { rows, total: 7, rework: [] }), /- more: mem-search `touched a\.ts`$/);
  assert.doesNotMatch(formatHint('a.ts', { rows, total: 3, rework: [] }), /more:/);
});
