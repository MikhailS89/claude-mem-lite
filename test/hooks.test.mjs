// End-to-end: run the real hook scripts as child processes, the way Claude
// Code does, against a temporary data directory.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { assistantText, bash, commitSession, sampleSession, toJsonl, userPrompt, writeLooseCommit } from './helpers.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'cml-hooks-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const projectDir = join(tmp, 'proj');
mkdirSync(join(projectDir, '.git'), { recursive: true });
writeFileSync(join(projectDir, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/me/proj.git\n');
const transcriptPath = join(tmp, 'sess-1.jsonl');
writeFileSync(transcriptPath, toJsonl(sampleSession({ cwd: projectDir })));

/**
 * The environment the hooks run with: the test runner's, minus the plugin's
 * own settings and the path to a real Claude Code. A developer who has commit
 * notes turned on must not get real model calls (and their cost) from tests.
 */
function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_MEM_LITE_') || k === 'CLAUDE_CODE_EXECPATH') delete env[k];
  return env;
}

function runHook(script, input, envExtra = {}, dataDir = join(tmp, 'data')) {
  const r = spawnSync(process.execPath, ['--no-warnings', join(root, 'scripts', script)], {
    input: input === null ? '' : typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: { ...cleanEnv(), CLAUDE_MEM_LITE_DIR: dataDir, CLAUDE_MEM_LITE_DEBUG: '1', ...envExtra },
    timeout: 20_000,
  });
  return { ...r, dataDir };
}

function runCli(args, dataDir = join(tmp, 'data'), envExtra = {}) {
  return spawnSync(process.execPath, ['--no-warnings', join(root, 'scripts', 'search.mjs'), ...args], {
    encoding: 'utf8',
    env: { ...cleanEnv(), CLAUDE_MEM_LITE_DIR: dataDir, ...envExtra },
    timeout: 20_000,
  });
}

const baseInput = {
  session_id: 'sess-1',
  transcript_path: transcriptPath,
  cwd: projectDir,
  hook_event_name: 'Stop',
};

test('hooks exit 0 and print nothing on empty or malformed stdin', () => {
  for (const script of ['session-start.mjs', 'session-stop.mjs', 'session-end.mjs']) {
    for (const input of [null, '{not json', '{}']) {
      const r = runHook(script, input);
      assert.equal(r.status, 0, `${script} ${input}: ${r.stderr}`);
      assert.equal(r.stdout, '', `${script} ${input} wrote to stdout`);
    }
  }
});

test('session-start prints nothing before any session is stored', () => {
  const r = runHook('session-start.mjs', { ...baseInput, hook_event_name: 'SessionStart' }, {}, join(tmp, 'empty'));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(existsSync(join(tmp, 'empty', 'memory.db')), false, 'SessionStart must not create the database');
});

test('stop -> end -> start round trip injects a recap', () => {
  let r = runHook('session-stop.mjs', baseInput);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.ok(existsSync(join(r.dataDir, 'memory.db')));

  r = runHook('session-end.mjs', { ...baseInput, hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' });
  assert.equal(r.status, 0, r.stderr);

  r = runHook('session-start.mjs', { ...baseInput, session_id: 'sess-2', hook_event_name: 'SessionStart' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(ctx, /Login bug fix/);
  assert.match(ctx, /- no commits recorded · 2 files: src\/auth\.ts, test\/auth\.test\.ts/);
  assert.match(ctx, /Thanks, also update the docs/);
  assert.match(ctx, /- outcome: Docs updated in README\.md\./);
  assert.match(ctx, /mem-search/);
  assert.ok(!ctx.includes('.env'));
  assert.ok(!ctx.includes('ghp_'));
  assert.ok(!ctx.includes('my secret note'));

  // The same session does not see itself.
  r = runHook('session-start.mjs', { ...baseInput, hook_event_name: 'SessionStart' });
  assert.equal(r.stdout, '');
});

test('CLI search, show, recent and touched work against the stored session', () => {
  let r = runCli(['--cwd', projectDir, 'login']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /session sess-1/);
  assert.match(r.stdout, /asked: Thanks, also update the docs/);

  r = runCli(['--cwd', projectDir, 'recent', '--json']);
  const rows = JSON.parse(r.stdout);
  assert.equal(rows.length, 1, 'one segment: the whole session, nothing committed');
  assert.equal(rows[0].status, 'ended');
  assert.equal(rows[0].commit_sha, null);
  r = runCli(['--cwd', projectDir, 'recent', '--sessions']);
  assert.match(r.stdout, /^sess-1 /);

  r = runCli(['show', 'sess-1']);
  assert.match(r.stdout, /Work \(1 segment, oldest first\):\n\nno commits recorded\n/);
  assert.match(r.stdout, /asked: Fix the login bug in the auth module/);
  assert.match(r.stdout, /files: src\/auth\.ts, test\/auth\.test\.ts/);
  assert.doesNotMatch(r.stdout, /Tools:|\.env|Commands/);
  r = runCli(['show', 'sess-1', '--json']);
  assert.match(r.stdout, /\[REDACTED\]/, 'commands are kept, with secrets masked');
  assert.ok(!r.stdout.includes('ghp_'));

  for (const cmd of ['touched', 'file']) {
    r = runCli(['--all', cmd, 'auth.test']);
    assert.match(r.stdout, /session sess-1/);
    assert.match(r.stdout, /write ×1: test\/auth\.test\.ts/);
  }

  r = runCli(['--cwd', join(tmp, 'elsewhere-nonexistent'), 'login']);
  assert.match(r.stdout, /No matching work/);
  r = runCli(['--all', 'login']);
  assert.match(r.stdout, /session sess-1/);
  r = runCli(['--all', 'recent', '--since', '1h']);
  assert.match(r.stdout, /No matching work/, 'the sample session is from 2026-09-21');
  r = runCli(['--all', 'recent', '--since', 'soon']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--since expects/);
});

test('CLI stats runs over the database and transcripts (this test project sits in a temp dir, so it is not counted)', () => {
  let r = runCli(['--cwd', projectDir, 'stats', '--json'], undefined, { CLAUDE_CONFIG_DIR: join(tmp, 'config') });
  assert.equal(r.status, 0, r.stderr);
  const s = JSON.parse(r.stdout);
  assert.equal(s.sessions, 0);
  assert.deepEqual(Object.keys(s.commitNotes), ['total', 'ok', 'costUsd']);
  r = runCli(['--all', 'stats'], undefined, { CLAUDE_CONFIG_DIR: join(tmp, 'config') });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /No sessions in scope/);
});

test('CLI forget removes the session and its segments', () => {
  const r = runCli(['forget', 'sess-1']);
  assert.match(r.stdout, /Deleted 1/);
  assert.match(runCli(['--all', 'recent']).stdout, /No matching work/);
  assert.match(runCli(['--all', 'login']).stdout, /No matching work/);
});

test('CLAUDE_MEM_LITE_ENABLED=false disables capture', () => {
  const dataDir = join(tmp, 'disabled-env');
  const r = runHook('session-stop.mjs', baseInput, { CLAUDE_MEM_LITE_ENABLED: 'false' }, dataDir);
  assert.equal(r.status, 0);
  assert.equal(existsSync(join(dataDir, 'memory.db')), false);
});

test('per-project marker file disables capture and recall', () => {
  const dataDir = join(tmp, 'disabled-marker');
  const markedProject = join(tmp, 'marked');
  mkdirSync(join(markedProject, '.claude-mem-lite'), { recursive: true });
  writeFileSync(join(markedProject, '.claude-mem-lite', 'disabled'), '');
  const r = runHook('session-stop.mjs', { ...baseInput, cwd: markedProject }, {}, dataDir);
  assert.equal(r.status, 0);
  assert.equal(existsSync(join(dataDir, 'memory.db')), false);
  const log = readFileSync(join(dataDir, 'hooks.log'), 'utf8');
  assert.match(log, /disabled for project/);
});

test('recap carries commits, HEAD at end and whether HEAD moved since', () => {
  const dataDir = join(tmp, 'git-state');
  const repo = join(tmp, 'repo-with-head');
  const sha = (c) => c.repeat(40);
  mkdirSync(join(repo, '.git', 'refs', 'heads'), { recursive: true });
  writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(repo, '.git', 'refs', 'heads', 'main'), `${sha('3')}\n`);
  // The transcript's commits exist in this repository (the lookup only needs the
  // object names); 2222222 is the pre-amend commit, which git keeps as a dangling object.
  for (const c of ['1', '2', '3']) {
    mkdirSync(join(repo, '.git', 'objects', c + c), { recursive: true });
    writeFileSync(join(repo, '.git', 'objects', c + c, c.repeat(38)), '');
  }
  const transcript = join(tmp, 'sess-c.jsonl');
  writeFileSync(transcript, toJsonl(commitSession({ cwd: repo })));
  const input = { session_id: 'sess-c', transcript_path: transcript, cwd: repo, hook_event_name: 'Stop' };

  // The fake .git is not a repository git itself can read: keep `git status`
  // out of this test (a real repository is exercised separately).
  const noStatus = { CLAUDE_MEM_LITE_GIT_STATUS: 'false' };
  let r = runHook('session-stop.mjs', input, noStatus, dataDir);
  assert.equal(r.status, 0, r.stderr);

  const recap = () => {
    const res = runHook('session-start.mjs', { ...input, session_id: 'next', hook_event_name: 'SessionStart' }, {}, dataDir);
    assert.equal(res.status, 0, res.stderr);
    return JSON.parse(res.stdout).hookSpecificOutput.additionalContext;
  };
  let ctx = recap();
  assert.match(ctx, /- work, oldest first:\n {2}- 1111111 feat: stage 0 skeleton · 2 files[^\n]*\n {2}- 3333333 feat: stage 1 content model · 1 file[^\n]*\n {2}- uncommitted · 1 file: README\.md/);
  assert.match(ctx, /HEAD at end: 3333333 \(main\) · edited after last commit: README\.md/);
  assert.match(ctx, /docs changed: docs\/ARCHITECTURE\.md, README\.md/);
  assert.doesNotMatch(ctx, /tool calls/);

  writeFileSync(join(repo, '.git', 'refs', 'heads', 'main'), `${sha('9')}\n`);
  ctx = recap();
  assert.match(ctx, /HEAD at end: 3333333 \(main\), now 9999999/);

  // The session goes on and commits with `-q`: no output, so the commit is
  // only found in .git, and it counts because it was made during that call.
  // (Built in order: the helpers hand out increasing timestamps per call.)
  const before = commitSession({ cwd: repo });
  const quietCall = bash('git commit -qam "docs: quiet commit"', '', { cwd: repo, sessionId: 'sess-c' });
  writeFileSync(transcript, toJsonl([...before, ...quietCall]));
  const quiet = writeLooseCommit(join(repo, '.git'), { parent: sha('3'), subject: 'docs: quiet commit', time: Date.parse(quietCall[1].timestamp) });
  // A commit typed in a terminal an hour later is on HEAD too, but not this session's.
  const terminal = writeLooseCommit(join(repo, '.git'), { parent: quiet, subject: 'chore: by hand', time: Date.parse(quietCall[1].timestamp) + 3600_000 });
  writeFileSync(join(repo, '.git', 'refs', 'heads', 'main'), `${terminal}\n`);
  r = runHook('session-stop.mjs', input, noStatus, dataDir);
  assert.equal(r.status, 0, r.stderr);
  ctx = recap();
  assert.match(ctx, new RegExp(`- 3333333 feat: stage 1 content model[^\\n]*\\n {2}- ${quiet.slice(0, 7)} docs: quiet commit · 1 file`));
  assert.doesNotMatch(ctx, /by hand|uncommitted/);
  assert.match(ctx, new RegExp(`HEAD at end: ${terminal.slice(0, 7)} \\(main\\) · no edits after last commit`));

  r = runCli(['show', 'sess-c'], dataDir);
  assert.match(r.stdout, /Work \(3 segments, oldest first\):/);
  assert.match(r.stdout, new RegExp(`\\n1111111 feat: stage 0 skeleton\\n[^]*\\n3333333 feat: stage 1 content model\\n[^]*\\n${quiet.slice(0, 7)} docs: quiet commit\\n`));
  assert.match(r.stdout, /files: README\.md/);
  assert.match(r.stdout, new RegExp(`HEAD at end: ${terminal.slice(0, 7)} \\(main\\)\\nEdited after last commit: none`));

  // A commit sha leads straight to its segment.
  r = runCli(['show', quiet.slice(0, 7)], dataDir);
  assert.match(r.stdout, new RegExp(`^${quiet.slice(0, 7)} docs: quiet commit\\n`));
  assert.match(r.stdout, /Part of session sess-c/);
});

test('listings call a session\'s tail "uncommitted", and a commitless session "no commits recorded"', () => {
  const dataDir = join(tmp, 'labels');
  const repo = join(tmp, 'labels-repo');
  mkdirSync(repo, { recursive: true });
  const transcript = join(tmp, 'sess-l.jsonl');
  writeFileSync(transcript, toJsonl(commitSession({ cwd: repo, sessionId: 'sess-l' })));
  runHook('session-stop.mjs', { session_id: 'sess-l', transcript_path: transcript, cwd: repo, hook_event_name: 'Stop' }, { CLAUDE_MEM_LITE_GIT_STATUS: 'false' }, dataDir);
  const r = runCli(['--cwd', repo, 'recent'], dataDir);
  assert.match(r.stdout, /uncommitted · 1 file: README\.md/);
  assert.doesNotMatch(r.stdout, /no commits recorded/);
});

test('with LLM summaries on, Stop starts a background worker that writes commit notes', async () => {
  const dataDir = join(tmp, 'notes');
  const repo = join(tmp, 'notes-repo');
  mkdirSync(repo, { recursive: true });
  const transcript = join(tmp, 'sess-n.jsonl');
  writeFileSync(transcript, toJsonl(commitSession({ cwd: repo, sessionId: 'sess-n' })));
  const env = {
    CLAUDE_MEM_LITE_GIT_STATUS: 'false',
    CLAUDE_MEM_LITE_LLM_SUMMARY: 'true',
    CLAUDE_MEM_LITE_CLAUDE_BIN: join(root, 'test', 'fixtures', 'fake-claude.mjs'),
  };
  const started = Date.now();
  const r = runHook('session-stop.mjs', { session_id: 'sess-n', transcript_path: transcript, cwd: repo, hook_event_name: 'Stop' }, env, dataDir);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(Date.now() - started < 5000, 'the hook does not wait for the model');

  // The worker is detached; wait for its note.
  let out = '';
  for (let i = 0; i < 50 && !/why: because of feat: stage 0 skeleton/.test(out); i++) {
    await new Promise((res) => setTimeout(res, 200));
    out = runCli(['--cwd', repo, 'touched', 'src/a.ts'], dataDir).stdout;
  }
  assert.match(out, /why: because of feat: stage 0 skeleton/);
  assert.match(readFileSync(join(dataDir, 'hooks.log'), 'utf8'), /notes: worker finished.*"done":1/);

  const recap = JSON.parse(runHook('session-start.mjs', { session_id: 'next', cwd: repo, hook_event_name: 'SessionStart' }, {}, dataDir).stdout).hookSpecificOutput.additionalContext;
  assert.match(recap, /- 1111111 feat: stage 0 skeleton[^\n]*\n {4}why: because of feat: stage 0 skeleton\n/);
});

test('the file-hint hook adds a file\'s history to the tool result, once, and can be turned off', () => {
  const dataDir = join(tmp, 'hints');
  // No .git: with an empty one the transcript's commits would rightly be
  // dropped as not belonging to this repository.
  const repo = join(tmp, 'hints-repo');
  mkdirSync(repo, { recursive: true });
  const transcript = join(tmp, 'sess-h.jsonl');
  writeFileSync(transcript, toJsonl(commitSession({ cwd: repo, sessionId: 'sess-h' })));
  runHook('session-stop.mjs', { session_id: 'sess-h', transcript_path: transcript, cwd: repo, hook_event_name: 'Stop' }, { CLAUDE_MEM_LITE_GIT_STATUS: 'false' }, dataDir);

  const read = { session_id: 'later', cwd: repo, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: join(repo, 'src', 'a.ts') } };
  let r = runHook('file-hint.mjs', read, {}, dataDir);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, 'PostToolUse');
  assert.match(out.additionalContext, /^claude-mem-lite: src\/a\.ts in earlier sessions \(1 change\):\n- \d{4}-\d{2}-\d{2} 1111111 feat: stage 0 skeleton$/);

  assert.equal(runHook('file-hint.mjs', read, {}, dataDir).stdout, '', 'second touch in the same session: silent');
  assert.equal(runHook('file-hint.mjs', { ...read, session_id: 'third' }, { CLAUDE_MEM_LITE_FILE_HINTS: 'false' }, dataDir).stdout, '');
  assert.equal(runHook('file-hint.mjs', { ...read, tool_input: { file_path: join(repo, 'src', 'never.ts') } }, {}, dataDir).stdout, '');
});

test('short sessions without changes give their recap places to real work', () => {
  const dataDir = join(tmp, 'trivial');
  const repo = join(tmp, 'trivial-repo');
  mkdirSync(repo, { recursive: true });
  const stop = (id, records) => {
    const t = join(tmp, `${id}.jsonl`);
    writeFileSync(t, toJsonl(records));
    runHook('session-stop.mjs', { session_id: id, transcript_path: t, cwd: repo, hook_event_name: 'Stop' }, { CLAUDE_MEM_LITE_GIT_STATUS: 'false' }, dataDir);
  };
  stop('work-1', commitSession({ cwd: repo, sessionId: 'work-1' }));
  stop('ask-1', [userPrompt('Привет, на чём остановились?', { cwd: repo, sessionId: 'ask-1' }), assistantText('На этапе 1.', { cwd: repo, sessionId: 'ask-1' })]);
  stop('ask-2', [userPrompt('claude plugin list', { cwd: repo, sessionId: 'ask-2' })]);

  const r = runHook('session-start.mjs', { session_id: 'now', cwd: repo, hook_event_name: 'SessionStart' }, {}, dataDir);
  const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /### [^\n]*Implement stage 1/, 'the real work is shown');
  assert.doesNotMatch(ctx, /### [^\n]*(на чём|plugin list)/, 'the check-ins are not');
  assert.match(ctx, /\(2 short sessions without changes not shown; latest \d{4}-\d{2}-\d{2} \d{2}:\d{2}: "claude plugin list"\)$/);

  const recent = runCli(['--cwd', repo, 'recent'], dataDir).stdout;
  assert.doesNotMatch(recent, /no project file changes/, 'talk-only segments are not recent work');
  assert.match(runCli(['--cwd', repo, 'остановились'], dataDir).stdout, /session ask-1/, 'but search still finds them');
});

test('with LLM summaries off (the default), no worker and no notes', () => {
  const dataDir = join(tmp, 'no-notes');
  const repo = join(tmp, 'no-notes-repo');
  mkdirSync(repo, { recursive: true });
  const transcript = join(tmp, 'sess-o.jsonl');
  writeFileSync(transcript, toJsonl(commitSession({ cwd: repo, sessionId: 'sess-o' })));
  runHook('session-stop.mjs', { session_id: 'sess-o', transcript_path: transcript, cwd: repo, hook_event_name: 'Stop' }, { CLAUDE_MEM_LITE_GIT_STATUS: 'false', CLAUDE_MEM_LITE_CLAUDE_BIN: join(root, 'test', 'fixtures', 'fake-claude.mjs') }, dataDir);
  assert.doesNotMatch(readFileSync(join(dataDir, 'hooks.log'), 'utf8'), /notes:/);
});

test('a real repository: git status after the turn says clean or what is uncommitted', { skip: spawnSync('git', ['--version']).status !== 0 && 'git not installed' }, () => {
  const dataDir = join(tmp, 'real-git');
  const repo = join(tmp, 'real-repo');
  mkdirSync(repo, { recursive: true });
  const git = (...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, windowsHide: true });
  git('init', '-q');
  writeFileSync(join(repo, 'a.txt'), 'a');
  git('add', 'a.txt');
  git('commit', '-q', '-m', 'init');
  const transcript = join(tmp, 'sess-g.jsonl');
  writeFileSync(transcript, toJsonl([userPrompt('change a', { cwd: repo, sessionId: 'sess-g' }), assistantText('done', { cwd: repo, sessionId: 'sess-g' })]));
  const input = { session_id: 'sess-g', transcript_path: transcript, cwd: repo, hook_event_name: 'Stop' };
  const recap = () =>
    JSON.parse(runHook('session-start.mjs', { ...input, session_id: 'next', hook_event_name: 'SessionStart' }, {}, dataDir).stdout).hookSpecificOutput.additionalContext;

  runHook('session-stop.mjs', input, {}, dataDir);
  assert.match(recap(), /HEAD at end: [0-9a-f]{7} \([^)]+\) · clean\n/);

  writeFileSync(join(repo, 'a.txt'), 'changed outside the session');
  writeFileSync(join(repo, '.env'), 'SECRET=1');
  runHook('session-stop.mjs', input, {}, dataDir);
  const ctx = recap();
  assert.match(ctx, /· 2 uncommitted: a\.txt \(\+1 more\)\n/, 'the .env file is counted but never named');
  assert.ok(!ctx.includes('.env'));
});

test('recap stays well-formed when prompts, answers and commits contain emoji', () => {
  const dataDir = join(tmp, 'emoji');
  const repo = join(tmp, 'emoji-repo');
  mkdirSync(repo, { recursive: true });
  const transcript = join(tmp, 'sess-e.jsonl');
  // Emoji placed so that the prompt (200) and outcome (300) cuts land inside pairs.
  const prompt = 'x'.repeat(198) + '😀😀 and more';
  const answer = 'y'.repeat(298) + '🐛🐛 tail';
  writeFileSync(transcript, toJsonl([userPrompt('first 🚀', { cwd: repo }), userPrompt(prompt, { cwd: repo }), assistantText(answer, { cwd: repo })]));
  const input = { session_id: 'sess-e', transcript_path: transcript, cwd: repo, hook_event_name: 'Stop' };
  assert.equal(runHook('session-stop.mjs', input, {}, dataDir).status, 0);

  const r = runHook('session-start.mjs', { ...input, session_id: 'next', hook_event_name: 'SessionStart' }, {}, dataDir);
  const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.ok(ctx.isWellFormed(), 'no lone surrogate');
  assert.ok(!/[\uD800-\uDFFF]/.test(ctx), 'no astral characters at all in injected context');
  assert.match(ctx, /last request: x+/);
});

test('a hook fired inside a subagent never touches the session record', () => {
  const dataDir = join(tmp, 'subagent');
  const r = runHook('session-stop.mjs', { ...baseInput, agent_id: 'a1', agent_type: 'Explore' }, {}, dataDir);
  assert.equal(r.status, 0);
  assert.equal(existsSync(join(dataDir, 'memory.db')), false);
  assert.match(readFileSync(join(dataDir, 'hooks.log'), 'utf8'), /subagent hook/);
});

test('a missing transcript is skipped without creating anything', () => {
  const dataDir = join(tmp, 'missing');
  const r = runHook('session-stop.mjs', { ...baseInput, transcript_path: join(tmp, 'nope.jsonl') }, {}, dataDir);
  assert.equal(r.status, 0);
  assert.equal(existsSync(join(dataDir, 'memory.db')), false);
});
