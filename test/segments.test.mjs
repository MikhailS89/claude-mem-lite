import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activeMinutes, buildSegments, removalsFromCommand } from '../src/segments.mjs';
import { displayPath } from '../src/summarize.mjs';

const T0 = Date.parse('2026-09-23T10:00:00Z');
const min = (m) => T0 + m * 60_000;
const edit = (path, m, kind = 'edit', doc = false) => ({ path, kind, ms: min(m), project: !path.startsWith('~/'), doc });

test('segments split at commits; the open tail exists only with uncommitted edits', () => {
  const { segments } = buildSegments({
    edits: [edit('a.ts', 1), edit('b.ts', 2), edit('a.ts', 12), edit('c.ts', 25)],
    prompts: [
      { text: 'build a', ms: min(0) },
      { text: 'commit it', ms: min(3) },
      { text: 'now c', ms: min(20) },
    ],
    commits: [
      { sha: '1111111', subject: 'feat: a and b', ms: min(5) },
      { sha: '2222222', subject: 'fix: a', ms: min(15) },
    ],
    startedAt: new Date(min(0)).toISOString(),
    endedAt: new Date(min(26)).toISOString(),
  });
  assert.deepEqual(
    segments.map((g) => [g.seq, g.commit?.sha ?? null, g.files.map((f) => f.path), g.prompts]),
    [
      [0, '1111111', ['a.ts', 'b.ts'], ['build a', 'commit it']],
      [1, '2222222', ['a.ts'], []],
      [2, null, ['c.ts'], ['now c']],
    ],
  );
  assert.equal(segments[1].startedAt, new Date(min(5)).toISOString(), 'a segment starts at the previous commit');
  assert.equal(segments[2].endedAt, new Date(min(26)).toISOString());

  const committed = buildSegments({
    edits: [edit('a.ts', 1)],
    prompts: [{ text: 'thanks', ms: min(9) }],
    commits: [{ sha: '1111111', subject: 'x', ms: min(5) }],
    startedAt: null,
    endedAt: null,
  });
  assert.equal(committed.segments.length, 1, 'no open segment for a chat after the last commit');

  const talk = buildSegments({ edits: [], prompts: [{ text: 'review PLAN.md', ms: min(1) }], commits: [], startedAt: null, endedAt: null });
  assert.equal(talk.segments.length, 1, 'a session without commits is one open segment');
  assert.equal(talk.segments[0].commit, null);
});

test('activeMinutes counts busy intervals and short gaps, not breaks', () => {
  assert.equal(activeMinutes([[min(0), min(0)], [min(5), min(5)], [min(8), min(8)]]), 8);
  assert.equal(activeMinutes([[min(0), min(0)], [min(90), min(90)]]), 0, 'a 90-minute silence is a break');
  assert.equal(activeMinutes([[min(0), min(40)], [min(41), min(41)]]), 41, 'a long command counts for its whole run');
  assert.equal(activeMinutes([[min(0), min(10)], [min(5), min(12)]]), 12, 'overlaps are not counted twice');
  assert.equal(activeMinutes([]), 0);
});

test('revisited: a code file returned to after other code work, never docs or steady progress', () => {
  const commits = [0, 1, 2, 3, 4].map((i) => ({ sha: `${i}`.repeat(7), subject: `c${i}`, ms: min(10 * i + 9) }));
  const { rework } = buildSegments({
    edits: [
      // names.cjs: segments 0 and 2, 6 edits -> revisited
      ...[1, 2, 3].map((m) => edit('names.cjs', m)),
      edit('other.ts', 12),
      ...[21, 22, 23].map((m) => edit('names.cjs', m)),
      // core.ts: every segment in a row -> progress
      ...[4, 14, 24, 34, 44].map((m) => edit('core.ts', m)),
      // ROADMAP.md: many segments, but a doc
      ...[5, 25, 45].map((m) => edit('docs/ROADMAP.md', m, 'edit', true)),
      // api.ts: segments 0 and 2, but only 2 edits -> not enough
      edit('api.ts', 6),
      edit('api.ts', 26),
    ],
    prompts: [],
    commits,
    startedAt: null,
    endedAt: null,
  });
  assert.deepEqual(
    rework.map((r) => [r.reason, r.path, r.edits, r.segments]),
    [['revisited', 'names.cjs', 6, [0, 2]]],
  );
});

test('a docs-only commit between two code commits is not a gap', () => {
  const commits = [0, 1, 2].map((i) => ({ sha: `${i}`.repeat(7), subject: `c${i}`, ms: min(10 * i + 9) }));
  const { rework } = buildSegments({
    edits: [
      ...[1, 2, 3].map((m) => edit('core.ts', m)),
      edit('README.md', 12, 'edit', true), // segment 1 only touches docs
      ...[21, 22, 23].map((m) => edit('core.ts', m)),
    ],
    prompts: [],
    commits,
    startedAt: null,
    endedAt: null,
  });
  assert.deepEqual(rework, []);
});

test('undone: created then deleted, edits discarded, and git reset --hard', () => {
  const { rework } = buildSegments({
    edits: [
      edit('src/partial/mode.ts', 1, 'write'),
      edit('src/partial/util.ts', 2, 'write'),
      edit('src/keep.ts', 3, 'edit'),
      edit('src/tried.ts', 4, 'edit'),
      edit('.tmp-input.json', 5, 'write'),
      edit('src/later.ts', 30, 'edit'),
    ],
    prompts: [],
    commits: [{ sha: '1111111', subject: 'x', ms: min(20) }],
    removals: [
      { targets: ['src/partial'], reason: 'deleted', ms: min(10) },
      { targets: ['src/keep.ts'], reason: 'deleted', ms: min(11) }, // existed before: not "created, then deleted"
      { targets: ['src/tried.ts'], reason: 'discarded', ms: min(12) },
      { targets: ['.tmp-input.json'], reason: 'deleted', ms: min(13) }, // scratch file: housekeeping
      { targets: ['*'], reason: 'discarded', ms: min(31) }, // reset --hard after the commit
    ],
    startedAt: null,
    endedAt: null,
  });
  assert.deepEqual(rework.map((r) => [r.reason, r.path]).sort(), [
    ['deleted', 'src/partial/mode.ts'],
    ['deleted', 'src/partial/util.ts'],
    ['discarded', 'src/later.ts'],
    ['discarded', 'src/tried.ts'],
  ]);
});

test('removalsFromCommand follows cd, Git Bash paths and git subcommands', () => {
  const root = process.platform === 'win32' ? 'C:\\proj' : '/proj';
  const abs = (p) => (process.platform === 'win32' ? `C:/proj/${p}` : `/proj/${p}`);
  const d = (a) => displayPath(a, root);
  assert.deepEqual(removalsFromCommand(`cd "${abs('backend')}" && rm -rf src/api/site-settings && node x.cjs`, root, d), [
    { targets: ['backend/src/api/site-settings'], reason: 'deleted' },
  ]);
  if (process.platform === 'win32') {
    assert.deepEqual(removalsFromCommand('cd /c/proj/frontend && rm public/robots.txt', root, d), [{ targets: ['frontend/public/robots.txt'], reason: 'deleted' }]);
  }
  assert.deepEqual(removalsFromCommand('git restore --staged a.ts; git restore b.ts; git checkout -- c.ts; git reset --hard; git rm -r old/', root, d), [
    { targets: ['b.ts'], reason: 'discarded' },
    { targets: ['c.ts'], reason: 'discarded' },
    { targets: ['*'], reason: 'discarded' },
    { targets: ['old'], reason: 'deleted' },
  ]);
  assert.deepEqual(removalsFromCommand('npm test && git status', root, d), []);
  assert.deepEqual(removalsFromCommand('git reset --soft HEAD~1', root, d), [], 'a soft reset keeps the edits');
});
