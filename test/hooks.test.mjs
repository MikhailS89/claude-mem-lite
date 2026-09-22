// End-to-end: run the real hook scripts as child processes, the way Claude
// Code does, against a temporary data directory.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { sampleSession, toJsonl } from './helpers.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'cml-hooks-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const projectDir = join(tmp, 'proj');
mkdirSync(join(projectDir, '.git'), { recursive: true });
writeFileSync(join(projectDir, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/me/proj.git\n');
const transcriptPath = join(tmp, 'sess-1.jsonl');
writeFileSync(transcriptPath, toJsonl(sampleSession({ cwd: projectDir })));

function runHook(script, input, envExtra = {}, dataDir = join(tmp, 'data')) {
  const r = spawnSync(process.execPath, ['--no-warnings', join(root, 'scripts', script)], {
    input: input === null ? '' : typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_MEM_LITE_DIR: dataDir, CLAUDE_MEM_LITE_DEBUG: '1', ...envExtra },
    timeout: 20_000,
  });
  return { ...r, dataDir };
}

function runCli(args, dataDir = join(tmp, 'data')) {
  return spawnSync(process.execPath, ['--no-warnings', join(root, 'scripts', 'search.mjs'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_MEM_LITE_DIR: dataDir },
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
  assert.match(ctx, /edited: src\/auth\.ts, test\/auth\.test\.ts/);
  assert.match(ctx, /ran: npm test, git commit/);
  assert.match(ctx, /Thanks, also update the docs/);
  assert.match(ctx, /mem-search/);
  assert.ok(!ctx.includes('.env'));
  assert.ok(!ctx.includes('ghp_'));
  assert.ok(!ctx.includes('my secret note'));

  // The same session does not see itself.
  r = runHook('session-start.mjs', { ...baseInput, hook_event_name: 'SessionStart' });
  assert.equal(r.stdout, '');
});

test('CLI search, show, recent and file work against the stored session', () => {
  let r = runCli(['--cwd', projectDir, 'login']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /sess-1/);

  r = runCli(['--cwd', projectDir, 'recent', '--json']);
  const rows = JSON.parse(r.stdout);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'ended');

  r = runCli(['show', 'sess-1']);
  assert.match(r.stdout, /Prompts:/);
  assert.match(r.stdout, /src\/auth\.ts \(edit/);
  assert.match(r.stdout, /\[REDACTED\]/);

  r = runCli(['--all', 'file', 'auth.test']);
  assert.match(r.stdout, /sess-1/);

  r = runCli(['--cwd', join(tmp, 'elsewhere-nonexistent'), 'login']);
  assert.match(r.stdout, /No matching sessions/);
  r = runCli(['--all', 'login']);
  assert.match(r.stdout, /sess-1/);
});

test('CLI forget removes the session', () => {
  const r = runCli(['forget', 'sess-1']);
  assert.match(r.stdout, /Deleted 1/);
  assert.match(runCli(['--all', 'recent']).stdout, /No matching sessions/);
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

test('a missing transcript is skipped without creating anything', () => {
  const dataDir = join(tmp, 'missing');
  const r = runHook('session-stop.mjs', { ...baseInput, transcript_path: join(tmp, 'nope.jsonl') }, {}, dataDir);
  assert.equal(r.status, 0);
  assert.equal(existsSync(join(dataDir, 'memory.db')), false);
});
