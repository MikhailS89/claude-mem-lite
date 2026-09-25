import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { MemoryDb } from '../src/db.mjs';
import { buildInput, findClaude, summarizeCommit } from '../src/llm.mjs';
import { pendingCommits, summarizePending } from '../src/notes.mjs';
import { formatSessionBrief, statedWhy } from '../src/recall.mjs';
import { summarize } from '../src/summarize.mjs';
import { parseTranscript } from '../src/transcript.mjs';
import { commitSession, PROJ, toJsonl } from './helpers.mjs';

const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-claude.mjs');
const tmp = mkdtempSync(join(tmpdir(), 'cml-notes-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const project = { id: 'path:c:/proj', root: PROJ, name: 'proj' };

function sessionDb() {
  const db = new MemoryDb(':memory:');
  db.upsertProject(project);
  const transcriptPath = join(tmp, `t-${Math.random()}.jsonl`);
  writeFileSync(transcriptPath, toJsonl(commitSession()));
  const { details, title, summary } = summarize(parseTranscript(readFileSync(transcriptPath, 'utf8')), project);
  db.upsertSession({ id: 'sess-c', projectId: project.id, title, summary, details, status: 'active' }, []);
  return { db, transcriptPath };
}

test('buildInput sends the commit, its files and the conversation, masked; nothing without conversation', () => {
  const seg = { commit: { sha: '1111111abc', subject: 'feat: names' }, files: [{ path: 'names.cjs', ops: 3 }], prompts: ['use my token ghp_abcdefghijklmnopqrstuvwxyz0123456789'] };
  const input = buildInput(seg, ['Dropped the external API <private>secret plan</private> because of cost.']);
  assert.match(input, /^Commit: 1111111 feat: names\nFiles: names\.cjs \(3 edits\)\nUser asked:\n- use my token \[REDACTED\]\nAssistant said:\n- Dropped the external API \[private\] because of cost\.$/);
  assert.equal(buildInput({ ...seg, prompts: [] }, []), null);
  const long = buildInput(seg, ['x'.repeat(800), 'y'.repeat(800), ...Array(20).fill('z'.repeat(700))]);
  assert.ok(long.length < 6400 && long.includes('[…]'), 'long conversations are cut from the middle');
});

test('summarizeCommit runs claude isolated and validates the answer', () => {
  const log = join(tmp, 'calls.jsonl');
  process.env.FAKE_CLAUDE_LOG = log;
  process.env.CLAUDE_CODE_SESSION_ID = 'parent-session';
  try {
    const r = summarizeCommit('Commit: 1234567 fix: parser\nUser asked:\n- fix it', { bin: FAKE, model: 'haiku' });
    assert.deepEqual(r, { ok: true, note: { type: 'feature', what: 'did fix: parser', why: 'because of fix: parser' }, costUsd: 0.001 });
    const call = JSON.parse(readFileSync(log, 'utf8').trim());
    assert.equal(call.memLiteEnabled, 'false', 'the child never records itself');
    assert.equal(call.sessionVar, null, "the parent session's variables do not leak");
    for (const flag of ['--no-session-persistence', '--json-schema', '--system-prompt', '--strict-mcp-config']) assert.ok(call.argv.includes(flag), flag);
    assert.equal(call.argv[call.argv.indexOf('--tools') + 1], '', 'no tools');
    assert.equal(call.argv[call.argv.indexOf('--setting-sources') + 1], '', "none of the user's hooks or settings");
    assert.equal(call.argv[call.argv.indexOf('--model') + 1], 'haiku');
  } finally {
    delete process.env.FAKE_CLAUDE_LOG;
    delete process.env.CLAUDE_CODE_SESSION_ID;
  }
  for (const [mode, error] of [['error', /exit 3: boom/], ['garbage', /unparseable/]]) {
    process.env.FAKE_CLAUDE_MODE = mode;
    try {
      const r = summarizeCommit('Commit: 1 x', { bin: FAKE });
      assert.equal(r.ok, false);
      assert.match(r.error, error);
    } finally {
      delete process.env.FAKE_CLAUDE_MODE;
    }
  }
  assert.equal(summarizeCommit('x', { bin: null }).ok, false);
});

test('findClaude prefers the running Claude Code, then PATH', () => {
  assert.equal(findClaude({ CLAUDE_CODE_EXECPATH: FAKE, PATH: '' }), FAKE);
  assert.equal(findClaude({ CLAUDE_CODE_EXECPATH: join(tmp, 'gone.exe'), PATH: '' }, tmp), null);
});

test('summarizePending notes each commit once, newest first, and skips commits without conversation', () => {
  const { db, transcriptPath } = sessionDb();
  assert.deepEqual(pendingCommits(db, 'sess-c').map((g) => g.commit.sha), ['1111111', '3333333']);
  const seen = [];
  const call = (input) => {
    seen.push(/^Commit: (\S+)/.exec(input)[1]);
    return { ok: true, note: { type: 'feature', what: 'w', why: 'the reason' }, costUsd: 0.002 };
  };
  // 1111111's window holds the user's prompt; 3333333's holds no conversation
  // at all (the prompt came before, the answer after), so it is not sent.
  const r = summarizePending(db, { sessionId: 'sess-c', transcriptPath, call });
  assert.deepEqual(r, { done: 1, skipped: 1, failed: 0 });
  assert.deepEqual(seen, ['1111111']);
  assert.deepEqual(pendingCommits(db, 'sess-c'), [], 'a skipped commit is not retried either');
  assert.equal(summarizePending(db, { sessionId: 'sess-c', transcriptPath, call }).done, 0, 'nothing twice');

  // Notes reach the listings and the search index.
  const [g] = db.searchSegments('reason');
  assert.equal(g.note_why, 'the reason');
  assert.equal(db.segmentByCommit('1111111').note_type, 'feature');
  assert.equal(db.segmentByCommit('3333333').note_type, null);
});

test('newest commits are summarised first when the budget is short', () => {
  const { db, transcriptPath } = sessionDb();
  const seen = [];
  const call = (input) => (seen.push(/^Commit: (\S+)/.exec(input)[1]), { ok: true, note: { type: 'fix', what: 'w', why: 'y' }, costUsd: 0 });
  // Give both commits a conversation by moving every prompt into 3333333's window too.
  const row = db.getSession('sess-c');
  const d = JSON.parse(row.details);
  d.segments[1].prompts = ['and the second one'];
  db.upsertSession({ id: 'sess-c', projectId: project.id, title: row.title, summary: row.summary, details: d, status: 'active' }, []);
  summarizePending(db, { sessionId: 'sess-c', transcriptPath, call, budget: 1 });
  assert.deepEqual(seen, ['3333333']);
});

test('failures are retried once, then left alone; a running worker is not duplicated', () => {
  const { db, transcriptPath } = sessionDb();
  const fail = () => ({ ok: false, error: 'timed out' });
  assert.equal(summarizePending(db, { sessionId: 'sess-c', transcriptPath, call: fail }).failed, 1);
  assert.equal(summarizePending(db, { sessionId: 'sess-c', transcriptPath, call: fail }).failed, 1, 'second attempt');
  assert.equal(summarizePending(db, { sessionId: 'sess-c', transcriptPath, call: fail }).failed, 0, 'given up after two');
  assert.match(db.notesFor(['1111111']).get('1111111').error, /timed out/);

  const other = sessionDb();
  other.db.setMeta('notes_lock:sess-c', new Date().toISOString());
  assert.equal(summarizePending(other.db, { sessionId: 'sess-c', transcriptPath: other.transcriptPath, call: fail }).locked, true);
  const stale = new Date(Date.now() - 11 * 60_000).toISOString();
  other.db.setMeta('notes_lock:sess-c', stale);
  assert.equal(summarizePending(other.db, { sessionId: 'sess-c', transcriptPath: other.transcriptPath, call: fail }).failed, 1, "a dead worker's lock expires");
});

test('the recap shows the stated why under the newest session\'s commits', () => {
  const { db } = sessionDb();
  db.putNote({ sha: '3333333', projectId: project.id, sessionId: 'sess-c', status: 'ok', type: 'feature', what: 'w', why: 'Отказались от внешнего API из-за цены.' });
  db.putNote({ sha: '1111111', projectId: project.id, sessionId: 'sess-c', status: 'ok', type: 'feature', what: 'w', why: 'not stated' });
  const row = db.getSession('sess-c');
  const notes = db.notesFor(['1111111', '3333333']);
  const out = formatSessionBrief(row, { notes });
  assert.match(out, /- 3333333 feat: stage 1 content model[^\n]*\n {4}why: Отказались от внешнего API из-за цены\.\n/);
  assert.doesNotMatch(out, /why: not stated/);
  assert.doesNotMatch(formatSessionBrief(row, { notes, newest: false }), /why:/);
  assert.equal(statedWhy({ why: 'Не указано.' }), null);
});
