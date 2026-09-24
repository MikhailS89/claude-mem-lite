import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { MemoryDb } from '../src/db.mjs';
import { findTranscript, reindexSome, transcriptRoots } from '../src/reindex.mjs';
import { commitSession, toJsonl } from './helpers.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'cml-reindex-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const roots = [join(tmp, 'projects')];
mkdirSync(join(roots[0], 'C--proj'), { recursive: true });

/** A row as 0.2 wrote it: no `format`, no segments. */
function legacyRow(id, updatedAt) {
  return {
    id,
    projectId: 'path:c:/proj',
    title: 'old',
    summary: '3 prompts, 7 tool calls',
    details: { prompts: [{ ts: '', text: 'old' }], commits: [] },
    cwd: 'C:\\proj',
    status: 'ended',
    endReason: 'prompt_input_exit',
    updatedAt,
  };
}

function freshDb() {
  const db = new MemoryDb(':memory:');
  db.upsertProject({ id: 'path:c:/proj', name: 'proj', root: 'C:\\proj' });
  return db;
}

test('transcriptRoots honours CLAUDE_CONFIG_DIR; findTranscript searches every project dir', () => {
  assert.deepEqual(transcriptRoots({ CLAUDE_CONFIG_DIR: join(tmp, 'cfg') }), [join(tmp, 'cfg', 'projects')]);
  writeFileSync(join(roots[0], 'C--proj', 'found-1.jsonl'), '');
  assert.equal(findTranscript('found-1', roots), join(roots[0], 'C--proj', 'found-1.jsonl'));
  assert.equal(findTranscript('nope', roots), null);
  assert.equal(findTranscript('x', [join(tmp, 'no-such-dir')]), null);
});

test('reindexSome rebuilds old rows from transcripts, keeps their place, and stops when done', () => {
  const db = freshDb();
  writeFileSync(join(roots[0], 'C--proj', 'old-1.jsonl'), toJsonl(commitSession({ sessionId: 'old-1', cwd: 'C:\\proj' })));
  db.upsertSession(legacyRow('old-1', '2026-09-01T00:00:00Z'), []);
  db.upsertSession(legacyRow('gone-1', '2026-09-02T00:00:00Z'), []);

  let r = reindexSome(db, { budget: 1, roots });
  assert.equal(r.rebuilt + r.missing, 1, 'the budget bounds one hook run');
  assert.equal(r.done, false);

  r = reindexSome(db, { budget: 5, roots });
  assert.equal(r.done, true);

  const row = db.getSession('old-1');
  const details = JSON.parse(row.details);
  assert.equal(details.format, 3);
  assert.ok(details.segments.length >= 2, 'segments rebuilt from the transcript');
  assert.equal(row.updated_at, '2026-09-01T00:00:00Z', 'keeps its place in "most recent" order');
  assert.equal(row.status, 'ended');
  assert.equal(row.end_reason, 'prompt_input_exit');
  assert.ok(db.sessionSegments('old-1').length >= 2);

  assert.equal(JSON.parse(db.getSession('gone-1').details).format, undefined, 'no transcript: stays a legacy record');
  assert.deepEqual(reindexSome(db, { roots }), { rebuilt: 0, missing: 0, remaining: 0, done: true }, 'later runs skip the scan');

  // An explicit reindex retries rows whose transcript was missing.
  writeFileSync(join(roots[0], 'C--proj', 'gone-1.jsonl'), toJsonl(commitSession({ sessionId: 'gone-1', cwd: 'C:\\proj' })));
  r = reindexSome(db, { budget: Infinity, roots, force: true });
  assert.equal(r.rebuilt, 1);
  assert.equal(JSON.parse(db.getSession('gone-1').details).format, 3);
});

test('a re-indexed old session takes HEAD at end from its own last commit, not today\'s HEAD', () => {
  const db = freshDb();
  writeFileSync(join(roots[0], 'C--proj', 'old-2.jsonl'), toJsonl(commitSession({ sessionId: 'old-2', cwd: 'C:\\proj' })));
  db.upsertSession(legacyRow('old-2', '2026-09-03T00:00:00Z'), []);
  reindexSome(db, { budget: 5, roots, force: true });
  const git = JSON.parse(db.getSession('old-2').details).git;
  assert.equal(git.head.sha, '3333333');
  assert.equal(git.worktree, null, 'git status would describe today, so it is left unknown');
});
