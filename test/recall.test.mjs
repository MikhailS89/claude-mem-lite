import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatSessionBrief, isTrivialSession, parseSince, pickSessions, reworkLines } from '../src/recall.mjs';
import { summarize } from '../src/summarize.mjs';
import { parseTranscript } from '../src/transcript.mjs';
import { commitSession, toJsonl } from './helpers.mjs';

const project = { id: 'path:c:/proj', root: 'C:\\proj', name: 'proj' };
const HEAD = { ref: 'main', sha: '3333333'.padEnd(40, '0') };

function row(details, extra = {}) {
  return {
    id: 'fff69b35-0000',
    started_at: '2026-09-22T11:20:00Z',
    updated_at: '2026-09-22T12:00:00Z',
    branch: 'main',
    title: 'Stage 1',
    status: 'ended',
    prompts: 24,
    tool_calls: 349,
    details: JSON.stringify(details),
    ...extra,
  };
}

const captured = (opts = {}) => summarize(parseTranscript(toJsonl(commitSession())), project, { head: HEAD, ...opts }).details;

test('recap leads with state, then segments, docs and the last request', () => {
  const out = formatSessionBrief(row(captured({ worktree: { clean: false, count: 2, paths: ['README.md', 'x.ts'], hidden: 0 } })));
  const lines = out.split('\n');
  assert.match(lines[0], /^### .* · main · Stage 1$/);
  assert.equal(lines[1], '- HEAD at end: 3333333 (main) · 2 uncommitted: README.md, x.ts');
  assert.equal(lines[2], '- work, oldest first:');
  assert.match(lines[3], /^ {2}- 1111111 feat: stage 0 skeleton · 2 files( · \d+ min)?$/);
  assert.match(lines[4], /^ {2}- 3333333 feat: stage 1 content model · 1 file/);
  assert.match(lines[5], /^ {2}- uncommitted · 1 file: README\.md/);
  assert.match(out, /- docs changed: docs\/ARCHITECTURE\.md, README\.md/);
  assert.match(out, /- last request: Implement stage 1/);
  assert.match(out, /- session: fff69b35$/);
  assert.doesNotMatch(out, /prompts|tool calls|ran:|outcome:|legacy/);
});

test('worktree state: clean, or fall back to Claude\'s own edits when git status is unknown', () => {
  assert.match(formatSessionBrief(row(captured({ worktree: { clean: true, count: 0, paths: [], hidden: 0 } }))), /HEAD at end: 3333333 \(main\) · clean\n/);
  assert.match(formatSessionBrief(row(captured())), /HEAD at end: 3333333 \(main\) · edited after last commit: README\.md\n/);
  const many = { clean: false, count: 14, paths: Array.from({ length: 10 }, (_, i) => `f${i}.ts`), hidden: 0 };
  assert.match(formatSessionBrief(row(captured({ worktree: many }))), /14 uncommitted: f0\.ts, f1\.ts, f2\.ts, f3\.ts, f4\.ts, f5\.ts \(\+8 more\)/);
});

test('recap says when HEAD moved since, comparing abbreviated and full shas', () => {
  const d = captured();
  assert.match(formatSessionBrief(row(d), { currentHead: HEAD }), /HEAD at end: 3333333 \(main\) ·/);
  d.git.head = { ref: 'main', sha: '3333333' }; // abbreviated, as re-indexing stores it
  assert.doesNotMatch(formatSessionBrief(row(d), { currentHead: HEAD }), /now/);
  assert.match(formatSessionBrief(row(d), { currentHead: { ref: 'feature', sha: 'd'.repeat(40) } }), /HEAD at end: 3333333 \(main\), now ddddddd \(feature\)/);
});

test('older sessions show fewer segments and no rework; the newest shows both', () => {
  const segments = Array.from({ length: 9 }, (_, i) => ({ seq: i, commit: { sha: `${i}`.repeat(7), subject: `c${i}` }, files: [], activeMin: 0 }));
  const rework = [
    { path: 'a.cjs', reason: 'revisited', segments: [1, 3, 5], edits: 21 },
    { path: 'gone.ts', reason: 'deleted', segments: [2], edits: 3 },
  ];
  const d = { segments, rework, git: null, filesEdited: [], prompts: [] };
  const newest = formatSessionBrief(row(d), { newest: true });
  assert.match(newest, /- work \(last 6 of 9 segments\), oldest first:\n {2}- 3333333 c3/);
  assert.match(newest, /- undone: gone\.ts \(created, then deleted\)\n- revisited after moving on: a\.cjs \(21 edits in 3 segments\)/);
  const older = formatSessionBrief(row(d), { newest: false });
  assert.match(older, /- work \(last 2 of 9 segments\), oldest first:\n {2}- 7777777 c7\n {2}- 8888888 c8/);
  assert.doesNotMatch(older, /undone|revisited/);
});

test('a session with no commits found claims nothing about committing', () => {
  const d = {
    segments: [{ seq: 0, commit: null, files: [{ path: 'PLAN.md', kind: 'edit', ops: 2 }, { path: '~/notes.md', kind: 'write', ops: 1 }], prompts: ['review'], activeMin: 12 }],
    rework: [],
    git: null,
    filesEdited: ['PLAN.md', '~/notes.md'],
    prompts: [{ ts: '', text: 'Понял, спасибо' }],
    outcome: '**Пожалуйста.** Перезапустите VS Code — и можно начинать. Если что-то не так, смотрите `hooks.log`.',
  };
  const out = formatSessionBrief(row(d));
  assert.match(out, /^- no commits recorded · 1 file: PLAN\.md · 1 outside the project · 12 min$/m);
  assert.doesNotMatch(out, /uncommitted/);
  assert.match(out, /- docs changed: PLAN\.md\n/);
  assert.match(out, /- outcome: Пожалуйста\. Перезапустите VS Code — и можно начинать\. Если что-то не так, смотрите hooks\.log\./);
});

test('rows written before segments render as legacy records', () => {
  const out = formatSessionBrief(
    row({
      title: 'PLAN.md review',
      prompts: [{ ts: '', text: 'Понял, спасибо' }],
      filesEdited: ['package.json', 'src/config.mjs'],
      commands: ['npm test', 'git commit -m x'],
      commits: [{ sha: '1234567', subject: 'init', branch: 'main' }],
      tools: { Bash: 3, Read: 6 },
      outcome: 'Пожалуйста.',
    }),
    { currentHead: HEAD },
  );
  assert.match(out.split('\n')[0], /· Stage 1 · legacy record$/);
  assert.match(out, /- commits:\n {2}- 1234567 init\n- edited: package\.json, src\/config\.mjs\n- last request: Понял, спасибо\n- session: fff69b35$/);
  assert.equal(formatSessionBrief(row({}, { details: 'not json' })).split('\n').length, 2);
});

test('reworkLines separates certain from suggestive signals', () => {
  assert.deepEqual(reworkLines([]), []);
  assert.deepEqual(
    reworkLines(
      [
        { path: 'x.ts', reason: 'discarded', segments: [0], edits: 2 },
        { path: 'a.ts', reason: 'revisited', segments: [0, 2], edits: 6 },
        { path: 'b.ts', reason: 'revisited', segments: [0, 2, 4], edits: 9 },
      ],
      1,
    ),
    ['undone: x.ts (edits discarded)', 'revisited after moving on: a.ts (6 edits in 2 segments) (+1 more)'],
  );
});

test('parseSince accepts relative spans and dates, rejects the rest', () => {
  const now = Date.parse('2026-09-24T12:00:00Z');
  assert.equal(parseSince('24h', now), '2026-09-23T12:00:00.000Z');
  assert.equal(parseSince('7d', now), '2026-09-17T12:00:00.000Z');
  assert.equal(parseSince('2w', now), '2026-09-10T12:00:00.000Z');
  assert.equal(parseSince('2026-09-01', now), '2026-09-01T00:00:00.000Z');
  assert.throws(() => parseSince('yesterday', now), /--since expects/);
  assert.throws(() => parseSince(undefined, now), /--since expects/);
});

// --- short sessions without changes (IDEAS 1.8) ---------------------------------

const trivialRow = (id, text, extra = {}) => ({
  id,
  started_at: extra.started_at ?? '2026-09-25T09:00:00Z',
  updated_at: extra.updated_at ?? '2026-09-25T09:05:00Z',
  status: 'ended',
  details: JSON.stringify({ format: 3, segments: [{ seq: 0, commit: null, files: [], prompts: [text] }], prompts: [{ ts: '', text }], filesEdited: [], stats: { prompts: 1 }, ...extra.details }),
});

test('a short session that changed nothing is trivial; real work and long talks are not', () => {
  assert.equal(isTrivialSession(trivialRow('t1', 'Привет, на чём остановились?')), true);
  assert.equal(isTrivialSession(trivialRow('t2', 'x', { details: { filesEdited: ['~/notes.md'] } })), true, 'edits outside the project do not count');
  assert.equal(isTrivialSession(trivialRow('t3', 'x', { details: { filesEdited: ['src/a.ts'] } })), false);
  assert.equal(isTrivialSession(trivialRow('t4', 'x', { details: { stats: { prompts: 12 } } })), false, 'a long discussion may hold a decision');
  assert.equal(isTrivialSession(trivialRow('t5', 'x', { details: { segments: [{ seq: 0, commit: { sha: 'a', subject: 's' }, files: [] }] } })), false);
  assert.equal(isTrivialSession(trivialRow('t6', 'x', { details: { rework: [{ path: 'a', reason: 'deleted', segments: [0], edits: 1 }] } })), false);
});

test('pickSessions fills the recap with real work and reports what it passed over', () => {
  const work = (id) => ({ ...trivialRow(id, 'x'), details: JSON.stringify({ format: 3, segments: [], filesEdited: ['src/a.ts'], stats: { prompts: 9 } }) });
  const list = [trivialRow('q1', 'где остановились'), work('w1'), trivialRow('q2', 'claude plugin list'), work('w2'), work('w3')];
  const { sessions, skipped } = pickSessions(list, 2);
  assert.deepEqual(sessions.map((s) => s.id), ['w1', 'w2']);
  assert.deepEqual(skipped.map((s) => s.id), ['q1', 'q2']);
  const only = pickSessions([trivialRow('q1', 'a'), trivialRow('q2', 'b')], 5);
  assert.deepEqual(only.sessions.map((s) => s.id), ['q1', 'q2'], 'all trivial: still show something');
  assert.deepEqual(only.skipped, []);
});
