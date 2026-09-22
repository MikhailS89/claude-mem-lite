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
