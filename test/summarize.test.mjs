import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandHead, displayPath, summarize } from '../src/summarize.mjs';
import { parseTranscript } from '../src/transcript.mjs';
import { sampleSession, toJsonl } from './helpers.mjs';

const project = { id: 'path:c:/proj', root: 'C:\\proj', name: 'proj' };

test('summarize produces an index-level summary and structured details', () => {
  const t = parseTranscript(toJsonl(sampleSession()));
  const r = summarize(t, project);

  assert.equal(r.title, 'Login bug fix');
  assert.match(r.summary, /Login bug fix/);
  assert.match(r.summary, /3 prompts, 7 tool calls/);
  assert.match(r.summary, /edited: src\/auth\.ts, test\/auth\.test\.ts/);
  assert.match(r.summary, /ran: npm test, git commit/);
  assert.match(r.summary, /last request: "Thanks, also update the docs"/);
  assert.match(r.summary, /outcome: "Docs updated in README\.md\."/);

  assert.deepEqual(r.details.filesEdited, ['src/auth.ts', 'test/auth.test.ts']);
  assert.deepEqual(r.details.filesRead, []);
  assert.deepEqual(r.details.searches, ['validateToken']);
  assert.deepEqual(r.details.tools, { Read: 2, Edit: 1, Write: 1, Bash: 2, Grep: 1 });
  assert.equal(r.stats.filesEdited, 2);
});

test('summarize never stores sensitive files, secrets or private text', () => {
  const t = parseTranscript(toJsonl(sampleSession()));
  const r = summarize(t, project);
  const everything = JSON.stringify(r);
  assert.ok(!everything.includes('.env'), 'sensitive path leaked');
  assert.equal(r.stats.sensitiveTouches, 1);
  assert.ok(!everything.includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789'), 'token leaked');
  assert.ok(everything.includes('[REDACTED]'));
  assert.ok(!everything.includes('my secret note'), 'private block leaked');
  assert.ok(!everything.includes('hidden.ts'), 'sidechain file leaked');
});

test('summarize handles an empty transcript', () => {
  const r = summarize(parseTranscript(''), project);
  assert.equal(r.title, '');
  assert.match(r.summary, /0 prompts, 0 tool calls/);
  assert.equal(r.files.length, 0);
});

test('displayPath relativises to the project root or home', () => {
  assert.equal(displayPath('C:\\proj\\src\\a.ts', 'C:\\proj', 'C:\\Users\\me'), 'src/a.ts');
  assert.equal(displayPath('C:\\Users\\me\\.claude\\x.md', 'C:\\proj', 'C:\\Users\\me'), '~/.claude/x.md');
  assert.equal(displayPath('D:\\other\\b.ts', 'C:\\proj', 'C:\\Users\\me'), 'D:/other/b.ts');
  assert.equal(displayPath('rel/c.ts', 'C:\\proj', 'C:\\Users\\me'), 'rel/c.ts');
});

test('commandHead reduces a command line to its verb', () => {
  assert.equal(commandHead('cd "C:\\my proj" && npm test -- --watch'), 'npm test');
  assert.equal(commandHead('(docker --version; docker compose version)'), 'docker');
  assert.equal(commandHead('FOO=1 BAR="x y" node scripts/x.mjs'), 'node scripts/x.mjs');
  assert.equal(commandHead('git commit -m "x"'), 'git commit');
  assert.equal(commandHead('git -C x status'), 'git');
  assert.equal(commandHead('/usr/bin/python3 -m pytest'), 'python3');
  assert.equal(commandHead(''), '');
});
