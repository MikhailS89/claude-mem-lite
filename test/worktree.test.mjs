import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { parsePorcelainZ, readWorktree } from '../src/worktree.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'cml-worktree-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const hasGit = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;

test('parsePorcelainZ counts every entry, skips rename sources and hides secrets', () => {
  const out = [' M src/a.ts', '?? new file.md', 'R  src/new.ts', 'src/old.ts', ' M .env', 'A  config/prod.pem', ''].join('\0');
  assert.deepEqual(parsePorcelainZ(out), { clean: false, count: 5, paths: ['src/a.ts', 'new file.md', 'src/new.ts'], hidden: 2 });
  assert.deepEqual(parsePorcelainZ(''), { clean: true, count: 0, paths: [], hidden: 0 });
});

test('readWorktree reports a real repository clean, then dirty', { skip: !hasGit && 'git not installed' }, () => {
  const git = (...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: tmp, windowsHide: true });
  git('init', '-q');
  writeFileSync(join(tmp, 'a.txt'), 'a');
  git('add', 'a.txt');
  git('commit', '-q', '-m', 'init');
  assert.deepEqual(readWorktree(tmp), { clean: true, count: 0, paths: [], hidden: 0 });

  writeFileSync(join(tmp, 'a.txt'), 'changed');
  writeFileSync(join(tmp, 'b.txt'), 'new');
  const wt = readWorktree(tmp);
  assert.equal(wt.clean, false);
  assert.deepEqual(wt.paths.sort(), ['a.txt', 'b.txt']);
});

test('readWorktree is null without git, outside a repo, or on timeout', () => {
  assert.equal(readWorktree(tmp, { git: 'definitely-not-git-xyz' }), null);
  assert.equal(readWorktree(null), null);
});
