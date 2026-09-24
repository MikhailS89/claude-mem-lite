import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { readHookInput } from '../src/hook-io.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('readHookInput resolves on a complete object without waiting for end-of-stream', async () => {
  const stream = new PassThrough();
  const pending = readHookInput(stream, 60_000);
  stream.write('{"session_id":"s1",');
  stream.write('"cwd":"C:\\\\proj"}'); // stdin left open, as Claude Code may do
  assert.deepEqual(await pending, { session_id: 's1', cwd: 'C:\\proj' });
  assert.ok(stream.destroyed, 'stdin is released so the process can exit');
});

test('readHookInput handles empty, malformed and stalled input', async () => {
  let stream = new PassThrough();
  let pending = readHookInput(stream, 60_000);
  stream.end();
  assert.deepEqual(await pending, {});

  stream = new PassThrough();
  pending = readHookInput(stream, 60_000);
  stream.end('{not json');
  await assert.rejects(pending, /malformed hook input/);

  stream = new PassThrough();
  pending = readHookInput(stream, 50);
  stream.write('{"half":');
  await assert.rejects(pending, /incomplete hook input/);

  stream = new PassThrough();
  assert.deepEqual(await readHookInput(stream, 50), {}, 'nothing at all: give up quietly');
});

test('the file-history hook is synchronous and covers reads and edits', () => {
  const hooks = JSON.parse(readFileSync(join(root, 'hooks', 'hooks.json'), 'utf8'));
  const [entry] = hooks.hooks.PostToolUse;
  assert.deepEqual(entry.matcher.split('|').sort(), ['Edit', 'MultiEdit', 'NotebookEdit', 'Read', 'Write']);
  assert.equal(entry.hooks[0].async, undefined, 'async hooks cannot add context');
  assert.ok(entry.hooks[0].timeout <= 5);
});

test('SessionStart also fires after /compact', () => {
  const hooks = JSON.parse(readFileSync(join(root, 'hooks', 'hooks.json'), 'utf8'));
  const matcher = hooks.hooks.SessionStart[0].matcher.split('|');
  assert.deepEqual(matcher.sort(), ['clear', 'compact', 'startup']);
});
