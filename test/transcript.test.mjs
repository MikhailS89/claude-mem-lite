import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeToolUse, parseTranscript } from '../src/transcript.mjs';
import { sampleSession, toJsonl } from './helpers.mjs';

test('parseTranscript extracts prompts, tool uses, title and metadata', () => {
  const t = parseTranscript(toJsonl(sampleSession()));
  assert.equal(t.sessionId, 'sess-1');
  assert.equal(t.cwd, 'C:\\proj');
  assert.equal(t.branch, 'main');
  assert.equal(t.title, 'Login bug fix');
  assert.deepEqual(
    t.prompts.map((p) => p.text),
    ['Fix the login bug in the auth module', 'Also add a test', 'Thanks, also update the docs'],
  );
  // The sidechain Read and the isMeta prompt are skipped.
  assert.deepEqual(
    t.toolUses.map((u) => u.name),
    ['Read', 'Edit', 'Write', 'Read', 'Bash', 'Bash', 'Grep'],
  );
  assert.equal(t.assistantTexts.length, 2);
  assert.ok(t.startedAt < t.endedAt);
});

test('parseTranscript tolerates garbage and partial lines', () => {
  const text = 'not json\n' + toJsonl(sampleSession()) + '{"type":"assistant","message":{"role":"assistant","content":[{"type":"te';
  const t = parseTranscript(text);
  assert.equal(t.prompts.length, 3);
  assert.equal(parseTranscript('').prompts.length, 0);
  assert.equal(parseTranscript('\n\n').toolUses.length, 0);
});

test('string user content that is an injected tag is not a prompt', () => {
  const rec = { type: 'user', message: { role: 'user', content: '<ide_opened_file>x</ide_opened_file>' } };
  assert.equal(parseTranscript(JSON.stringify(rec)).prompts.length, 0);
  const rec2 = { type: 'user', message: { role: 'user', content: 'plain string prompt' } };
  assert.equal(parseTranscript(JSON.stringify(rec2)).prompts[0].text, 'plain string prompt');
});

test('describeToolUse maps tools to files, commands and searches', () => {
  assert.deepEqual(describeToolUse('Edit', { file_path: 'a.ts' }), { file: { path: 'a.ts', kind: 'edit' } });
  assert.deepEqual(describeToolUse('Read', { file_path: 'a.ts' }), { file: { path: 'a.ts', kind: 'read' } });
  assert.deepEqual(describeToolUse('NotebookEdit', { notebook_path: 'n.ipynb' }), { file: { path: 'n.ipynb', kind: 'edit' } });
  assert.deepEqual(describeToolUse('Bash', { command: 'ls' }), { command: 'ls' });
  assert.deepEqual(describeToolUse('Grep', { pattern: 'foo' }), { search: 'foo' });
  assert.deepEqual(describeToolUse('mcp__x__y', { a: 1 }), {});
  assert.deepEqual(describeToolUse('Read', {}), {});
});
