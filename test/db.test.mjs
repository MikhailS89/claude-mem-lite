import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryDb, ftsTerms } from '../src/db.mjs';

const projectA = { id: 'git:github.com/me/a', name: 'a', root: 'C:\\a' };
const projectB = { id: 'path:c:/b', name: 'b', root: 'C:\\b' };

function session(id, projectId, extra = {}) {
  return {
    id,
    projectId,
    title: extra.title ?? `Session ${id}`,
    summary: extra.summary ?? `summary of ${id}`,
    details: extra.details ?? { prompts: [{ ts: '', text: extra.prompt ?? 'hello' }], commands: extra.commands ?? [] },
    startedAt: extra.startedAt ?? '2026-09-01T00:00:00Z',
    endedAt: extra.endedAt ?? '2026-09-01T01:00:00Z',
    prompts: 1,
    toolCalls: 2,
    status: extra.status ?? 'ended',
  };
}

function seeded() {
  const db = new MemoryDb(':memory:');
  db.upsertProject(projectA);
  db.upsertProject(projectB);
  db.upsertSession(session('s1', projectA.id, { title: 'Login bug fix', prompt: 'fix the login bug', commands: ['npm test'] }), [
    { path: 'src/auth.ts', kind: 'edit', ops: 2 },
  ]);
  db.upsertSession(session('s2', projectA.id, { title: 'Архитектура проекта', prompt: 'давай зафиксируем кэш в CONTEXT.md' }), [
    { path: 'CONTEXT.md', kind: 'write', ops: 1 },
  ]);
  db.upsertSession(session('s3', projectB.id, { title: 'Other project login', prompt: 'login page styling' }), []);
  return db;
}

test('upsertSession is idempotent and refreshes files + fts', () => {
  const db = seeded();
  db.upsertSession(session('s1', projectA.id, { title: 'Login bug fix v2', prompt: 'fix the login bug again' }), [
    { path: 'src/auth2.ts', kind: 'edit', ops: 1 },
  ]);
  assert.equal(db.countSessions(projectA.id), 2);
  assert.equal(db.getSession('s1').title, 'Login bug fix v2');
  assert.deepEqual(
    db.getSessionFiles('s1').map((f) => f.path),
    ['src/auth2.ts'],
  );
  assert.equal(db.search('again', { projectId: projectA.id }).length, 1);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM sessions_fts').get().n, 3);
});

test('search finds a session by a commit subject or sha', () => {
  const db = seeded();
  db.upsertSession(
    session('s4', projectA.id, {
      details: { prompts: [], commits: [{ sha: 'ae2da15', subject: 'feat: контент-модель каталога', branch: 'main' }] },
    }),
    [],
  );
  assert.deepEqual(db.search('контент-модель', { projectId: projectA.id }).map((s) => s.id), ['s4']);
  assert.deepEqual(db.search('ae2da15', { projectId: projectA.id }).map((s) => s.id), ['s4']);
});

test('recentSessions scopes by project and excludes the current session', () => {
  const db = seeded();
  assert.deepEqual(
    db.recentSessions({ projectId: projectA.id }).map((s) => s.id).sort(),
    ['s1', 's2'],
  );
  assert.deepEqual(db.recentSessions({ projectId: projectA.id, excludeId: 's2' }).map((s) => s.id), ['s1']);
  assert.equal(db.recentSessions({ limit: 10 }).length, 3);
});

test('search finds by title, prompt, file and command, scoped to project', () => {
  const db = seeded();
  assert.deepEqual(db.search('login', { projectId: projectA.id }).map((s) => s.id), ['s1']);
  assert.equal(db.search('login').length, 2);
  assert.deepEqual(db.search('auth.ts', { projectId: projectA.id }).map((s) => s.id), ['s1']);
  assert.deepEqual(db.search('npm', { projectId: projectA.id }).map((s) => s.id), ['s1']);
  assert.deepEqual(db.search('кэш', { projectId: projectA.id }).map((s) => s.id), ['s2']);
  assert.deepEqual(db.search('архитект', { projectId: projectA.id }).map((s) => s.id), ['s2']);
  assert.equal(db.search('nothing-like-this').length, 0);
  assert.equal(db.search('').length, 0);
});

test('search falls back to OR when the AND query is empty', () => {
  const db = seeded();
  const ids = db.search('login кэш', { projectId: projectA.id }).map((s) => s.id).sort();
  assert.deepEqual(ids, ['s1', 's2']);
});

test('search survives FTS operator characters in the query', () => {
  const db = seeded();
  assert.doesNotThrow(() => db.search('"login" OR (bug) NOT * ^ AND'));
  assert.doesNotThrow(() => db.search('src/auth.ts -x --y "unterminated'));
});

test('searchByFile matches a path fragment case-insensitively', () => {
  const db = seeded();
  assert.deepEqual(db.searchByFile('AUTH').map((s) => s.id), ['s1']);
  assert.deepEqual(db.searchByFile('context.md', { projectId: projectB.id }), []);
});

test('getSession accepts an id prefix', () => {
  const db = seeded();
  assert.equal(db.getSession('s2').id, 's2');
  assert.equal(db.getSession('zzz'), null);
});

test('deleteSession and deleteProject clean up fts and files', () => {
  const db = seeded();
  assert.equal(db.deleteSession('s1'), 1);
  assert.equal(db.search('login', { projectId: projectA.id }).length, 0);
  assert.equal(db.getSessionFiles('s1').length, 0);
  assert.equal(db.deleteProject(projectA.id), 1);
  assert.equal(db.countSessions(), 1);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM sessions_fts').get().n, 1);
});

test('listProjects reports session counts', () => {
  const db = seeded();
  const rows = db.listProjects();
  assert.equal(rows.find((p) => p.id === projectA.id).sessions, 2);
  assert.equal(rows.find((p) => p.id === projectB.id).sessions, 1);
});

test('ftsTerms quotes and prefixes each token', () => {
  assert.deepEqual(ftsTerms('fix login "bug"'), ['"fix"*', '"login"*', '"bug"*']);
  assert.deepEqual(ftsTerms('a'), []);
});

// --- segments -------------------------------------------------------------------

function segmented(id, projectId, segments, extra = {}) {
  return session(id, projectId, { ...extra, details: { format: 3, prompts: [], segments } });
}

const seg = (seq, sha, subject, endedAt, files, prompts = []) => ({
  seq,
  startedAt: null,
  endedAt,
  activeMin: 5,
  commit: sha ? { sha, subject } : null,
  files: files.map((path) => ({ path, kind: 'edit', ops: 2 })),
  prompts,
});

function withSegments() {
  const db = seeded();
  db.upsertSession(
    segmented('s4', projectA.id, [
      seg(0, 'aaaaaaa', 'feat: exercise names translation', '2026-09-20T10:00:00Z', ['scripts/names.cjs', 'README.md'], ['translate the names']),
      seg(1, 'bbbbbbb', 'fix: transliteration rule', '2026-09-22T10:00:00Z', ['scripts/names.cjs']),
      seg(2, null, null, '2026-09-22T11:00:00Z', ['src/app.vue']),
    ]),
    [],
  );
  db.upsertSession(segmented('s5', projectB.id, [seg(0, 'ccccccc', 'other project', '2026-09-23T10:00:00Z', ['scripts/names.cjs'])]), []);
  return db;
}

test('segments are stored with their files, replaced on upsert, listed newest first', () => {
  const db = withSegments();
  assert.deepEqual(
    db.recentSegments({ projectId: projectA.id }).map((g) => [g.seq, g.commit_sha]),
    [
      [2, null],
      [1, 'bbbbbbb'],
      [0, 'aaaaaaa'],
    ],
  );
  const first = db.sessionSegments('s4')[0];
  assert.deepEqual(first.files.map((f) => f.path), ['README.md', 'scripts/names.cjs']);
  assert.deepEqual(first.prompts, ['translate the names']);
  assert.equal(first.branch, null);

  db.upsertSession(segmented('s4', projectA.id, [seg(0, 'ddddddd', 'rewritten', '2026-09-24T10:00:00Z', ['x.ts'])]), []);
  assert.deepEqual(db.sessionSegments('s4').map((g) => g.commit_sha), ['ddddddd']);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM segment_files WHERE session_id = 's4'").get().n, 1);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM segments_fts WHERE session_id = 's4'").get().n, 1);
});

test('recentSegments honours since and excludes a session', () => {
  const db = withSegments();
  assert.deepEqual(db.recentSegments({ since: '2026-09-22T00:00:00Z' }).map((g) => g.commit_sha ?? 'open'), ['ccccccc', 'open', 'bbbbbbb']);
  assert.deepEqual(db.recentSegments({ excludeSessionId: 's4' }).map((g) => g.session_id), ['s5']);
});

test('touched finds the segments that edited a file, newest first, scoped by project', () => {
  const db = withSegments();
  const rows = db.touched('names.cjs', { projectId: projectA.id });
  assert.deepEqual(rows.map((g) => g.commit_sha), ['bbbbbbb', 'aaaaaaa']);
  assert.deepEqual(rows[1].matched.map((f) => f.path), ['scripts/names.cjs']);
  assert.equal(db.touched('names.cjs').length, 3, 'all projects');
  assert.equal(db.touched('NAMES.CJS', { projectId: projectA.id }).length, 2, 'case-insensitive');
  assert.equal(db.touched('names.cjs', { projectId: projectA.id, since: '2026-09-21T00:00:00Z' }).length, 1);
});

test('searchSegments ranks commit subjects and prompts; segmentByCommit takes a prefix', () => {
  const db = withSegments();
  assert.deepEqual(db.searchSegments('transliteration').map((g) => g.commit_sha), ['bbbbbbb']);
  assert.deepEqual(db.searchSegments('translate names').map((g) => g.commit_sha), ['aaaaaaa']);
  assert.deepEqual(db.searchSegments('names', { projectId: projectB.id }).map((g) => g.commit_sha), ['ccccccc']);
  assert.equal(db.segmentByCommit('bbbb').commit_subject, 'fix: transliteration rule');
  assert.equal(db.segmentByCommit('zzzz'), null);
  assert.equal(db.segmentByCommit('eeee'), null);
});

test('deleting a session or project removes its segments and their index', () => {
  const db = withSegments();
  db.deleteSession('s4');
  assert.equal(db.searchSegments('transliteration').length, 0);
  assert.equal(db.recentSegments({ projectId: projectA.id }).length, 0);
  db.deleteProject(projectB.id);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM segments_fts').get().n, 0);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM segment_files').get().n, 0);
});

test('sessionsOlderThan finds rows written before a details format; updatedAt can be kept', () => {
  const db = withSegments();
  assert.deepEqual(db.sessionsOlderThan(3).map((s) => s.id).sort(), ['s1', 's2', 's3']);
  db.upsertSession({ ...segmented('s1', projectA.id, []), updatedAt: '2020-01-01T00:00:00Z' }, []);
  assert.equal(db.getSession('s1').updated_at, '2020-01-01T00:00:00Z');
  assert.deepEqual(db.sessionsOlderThan(3).map((s) => s.id).sort(), ['s2', 's3']);
  db.setMeta('k', 'v');
  assert.equal(db.getMeta('k'), 'v');
  assert.equal(db.getMeta('missing'), null);
});
