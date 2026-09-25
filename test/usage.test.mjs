import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { MemoryDb } from '../src/db.mjs';
import { resolveProject } from '../src/project.mjs';
import { collectStats } from '../src/stats.mjs';
import { displayPath, summarize } from '../src/summarize.mjs';
import { parseTranscript } from '../src/transcript.mjs';
import { aggregateUsage, memLookup, usageOf } from '../src/usage.mjs';
import { assistantBlocks, PROJ, toJsonl, toolUse, under, userPrompt } from './helpers.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'cml-usage-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

/** What Claude Code records when a hook adds context. */
function injection(event, text, { sidechain = false, sessionId = 'sess-u', cwd = PROJ } = {}) {
  return {
    type: 'attachment',
    sessionId,
    cwd,
    isSidechain: sidechain,
    timestamp: '2026-09-21T09:00:00.000Z',
    attachment: { type: 'hook_additional_context', hookName: `${event}:startup`, hookEvent: event, toolUseID: 'x', content: [text] },
  };
}

function edit(id, path, { isError = false, ...o } = {}) {
  return [
    assistantBlocks([{ type: 'tool_use', id, name: 'Edit', input: { file_path: path, old_string: 'a', new_string: 'b' } }], o),
    userPrompt([{ type: 'tool_result', tool_use_id: id, content: isError ? 'String to replace not found' : 'ok', is_error: isError }], o),
  ];
}

const RECAP = '# claude-mem-lite: previous sessions in this project (proj)\n3 sessions stored locally.';
const SEARCH = `node --no-warnings "C:/Users/me/.claude/plugins/claude-mem-lite/scripts/search.mjs"`;

/** Recap, two hints, one lookup, git log, a failed edit, an edit outside the project, then the first real edit. */
function usedSession(o = {}) {
  const opts = { sessionId: 'sess-u', cwd: PROJ, ...o };
  const f = (rel) => under(opts.cwd, rel);
  return [
    injection('SessionStart', RECAP, opts),
    injection('SessionStart', 'some other plugin said hello', opts),
    userPrompt('Continue with stage 2', opts),
    toolUse('Bash', { command: `${SEARCH} touched auth.ts` }, opts),
    toolUse('Bash', { command: 'git log --oneline -5' }, opts),
    toolUse('Read', { file_path: f('src/auth.ts') }, opts),
    injection('PostToolUse', 'claude-mem-lite: src/auth.ts in earlier sessions (2 changes):', opts),
    injection('PostToolUse', 'claude-mem-lite: sidechain hint', { ...opts, sidechain: true }),
    ...edit('toolu_fail', f('src/auth.ts'), { ...opts, isError: true }),
    ...edit('toolu_notes', under(tmp, 'notes.md'), opts),
    ...edit('toolu_ok', f('src/auth.ts'), opts),
    toolUse('Bash', { command: 'git log -1' }, opts),
    toolUse('Bash', { command: `${SEARCH} show 1a2b3c4` }, opts),
  ];
}

test('parseTranscript keeps what this plugin injected, not other hooks or subagents', () => {
  const t = parseTranscript(toJsonl(usedSession()));
  assert.deepEqual(
    t.injections.map((i) => [i.event, i.chars]),
    [
      ['SessionStart', RECAP.length],
      ['PostToolUse', 'claude-mem-lite: src/auth.ts in earlier sessions (2 changes):'.length],
    ],
  );
  assert.equal(t.prompts.length, 1, 'attachments are not prompts');
});

test('memLookup counts the skill\'s lookups, not maintenance, development or test databases', () => {
  assert.equal(memLookup(`${SEARCH} touched src/auth.ts`), 'touched');
  assert.equal(memLookup(`${SEARCH} --since 7d recent`), 'recent');
  assert.equal(memLookup(`${SEARCH} --limit 5 login bug`), 'search');
  assert.equal(memLookup('node "${CLAUDE_PLUGIN_ROOT}/scripts/search.mjs" show abc'), 'show');
  assert.equal(memLookup('node /home/me/cml/scripts/search.mjs file x.ts'), 'file');
  assert.equal(memLookup(`${SEARCH} replay x.jsonl`), null);
  assert.equal(memLookup(`${SEARCH} stats`), null);
  assert.equal(memLookup(`${SEARCH} --help`), null);
  assert.equal(memLookup('node scripts/search.mjs recent'), null, 'relative path: working on the plugin');
  assert.equal(memLookup('node ./scripts/search.mjs recent'), null);
  assert.equal(memLookup(`CLAUDE_MEM_LITE_DIR=/tmp/x ${SEARCH} recent`), null, 'a test database');
  assert.equal(memLookup('git log'), null);
});

test('usageOf: recap, hints, lookups and the orientation phase before the first project edit', () => {
  const u = usageOf(parseTranscript(toJsonl(usedSession())), (p) => displayPath(p, PROJ));
  assert.equal(u.recaps, 1);
  assert.equal(u.recapChars, RECAP.length);
  assert.equal(u.hints, 1);
  assert.deepEqual(u.memSearch, { touched: 1, show: 1 });
  // search, git log, read, failed edit, edit outside the project -> the 6th call edits.
  assert.equal(u.callsBeforeEdit, 5);
  assert.equal(u.historyBeforeEdit, 1, 'git log after the first edit is not orientation');
});

test('usageOf: a session without edits has no orientation figures', () => {
  const u = usageOf(parseTranscript(toJsonl([userPrompt('what is this?'), toolUse('Bash', { command: 'git log' })])));
  assert.equal(u.recaps, 0);
  assert.equal(u.callsBeforeEdit, null);
  assert.equal(u.historyBeforeEdit, null);
});

test('summarize stores usage in details', () => {
  const { details } = summarize(parseTranscript(toJsonl(usedSession())), { root: PROJ });
  assert.equal(details.usage.recaps, 1);
  assert.equal(details.usage.callsBeforeEdit, 5);
});

test('aggregateUsage compares sessions with and without a recap', () => {
  const base = { recapChars: 0, hints: 0, memSearch: {}, historyBeforeEdit: 0 };
  const a = aggregateUsage([
    { ...base, recaps: 1, recapChars: 1000, callsBeforeEdit: 2, hints: 3, memSearch: { touched: 2 } },
    { ...base, recaps: 1, recapChars: 2000, callsBeforeEdit: 4 },
    { ...base, recaps: 2, recapChars: 3000, callsBeforeEdit: null, historyBeforeEdit: null },
    { ...base, recaps: 0, callsBeforeEdit: 10, historyBeforeEdit: 2, memSearch: { show: 1 } },
  ]);
  assert.equal(a.sessions, 4);
  assert.deepEqual(a.withRecap, { sessions: 3, edited: 2, medianCallsBeforeEdit: 3, historyLookupsPerSession: 0, sessionsWithHistoryLookups: 0 });
  assert.deepEqual(a.withoutRecap, { sessions: 1, edited: 1, medianCallsBeforeEdit: 10, historyLookupsPerSession: 2, sessionsWithHistoryLookups: 1 });
  assert.equal(a.recapChars, 2000);
  assert.equal(a.hints, 3);
  assert.deepEqual(a.memSearch, { calls: 3, sessions: 2, bySubcommand: { touched: 2, show: 1 } });
  assert.equal(aggregateUsage([]).withRecap.medianCallsBeforeEdit, null);
});

test('collectStats: recorded sessions, transcripts the plugin never saw, scratch dirs and note costs', () => {
  const roots = [join(tmp, 'projects')];
  const dir = join(roots[0], 'C--proj');
  mkdirSync(dir, { recursive: true });
  const scratch = join(tmp, 'scratch');
  const project = resolveProject(PROJ);

  const db = new MemoryDb(':memory:');
  db.upsertProject({ id: project.id, name: 'proj', root: PROJ });
  const recorded = summarize(parseTranscript(toJsonl(usedSession())), { root: PROJ });
  db.upsertSession({ id: 'sess-u', projectId: project.id, title: 't', summary: 's', details: recorded.details, cwd: PROJ, status: 'ended', updatedAt: '2026-09-21T10:00:00Z' }, []);
  writeFileSync(join(dir, 'sess-u.jsonl'), toJsonl(usedSession())); // recorded: not counted twice
  // Before the plugin: no recap, straight to an edit after one read.
  writeFileSync(
    join(dir, 'old-1.jsonl'),
    toJsonl([userPrompt('fix it', { sessionId: 'old-1' }), toolUse('Read', { file_path: under(PROJ, 'a.ts') }, { sessionId: 'old-1' }), ...edit('toolu_o', under(PROJ, 'a.ts'), { sessionId: 'old-1' })]),
  );
  // A check run in a scratch directory.
  writeFileSync(join(dir, 'tmp-1.jsonl'), toJsonl([userPrompt('x', { sessionId: 'tmp-1', cwd: scratch }), ...edit('toolu_t', join(scratch, 'a.ts'), { sessionId: 'tmp-1', cwd: scratch })]));
  db.putNote({ sha: 'aaaaaaa', projectId: project.id, sessionId: 'sess-u', status: 'ok', what: 'w', why: 'y', costUsd: 0.015 });
  db.putNote({ sha: 'bbbbbbb', projectId: project.id, sessionId: 'sess-u', status: 'skipped', costUsd: 0.002 });

  const s = collectStats(db, { projectId: project.id, roots, scratch });
  assert.equal(s.sessions, 2);
  assert.equal(s.unrecorded, 1);
  assert.equal(s.withRecap.medianCallsBeforeEdit, 5);
  assert.equal(s.withoutRecap.medianCallsBeforeEdit, 1);
  assert.equal(s.commitNotes.total, 2);
  assert.equal(s.commitNotes.ok, 1);
  assert.ok(Math.abs(s.commitNotes.costUsd - 0.017) < 1e-9, "skipped and failed calls cost money too");

  assert.equal(collectStats(db, { projectId: 'git:elsewhere', roots, scratch }).sessions, 0);
  assert.equal(collectStats(db, { roots, scratch: null }).sessions, 3, 'without a scratch dir the check run counts');
});

