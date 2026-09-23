import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { findGitRoot, normalizeRemote, objectLookup, readCommits, readHead, readRemoteUrl, resolveProject } from '../src/project.mjs';
import { writeLooseCommit } from './helpers.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'cml-project-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

test('normalizeRemote unifies ssh/https/scp forms and drops credentials', () => {
  const expected = 'github.com/Owner/Repo';
  for (const url of [
    'git@github.com:Owner/Repo.git',
    'https://github.com/Owner/Repo.git',
    'https://github.com/Owner/Repo',
    'https://user:token@github.com/Owner/Repo.git',
    'ssh://git@github.com/Owner/Repo.git',
    'ssh://git@github.com:22/Owner/Repo.git',
    'GitHub.com/Owner/Repo/',
  ]) {
    assert.equal(normalizeRemote(url), expected, url);
  }
  assert.equal(normalizeRemote('https://gitlab.example.com:8443/group/sub/proj.git'), 'gitlab.example.com/group/sub/proj');
});

test('resolveProject uses the remote when present', () => {
  const root = join(tmp, 'with-remote');
  mkdirSync(join(root, '.git'), { recursive: true });
  mkdirSync(join(root, 'src', 'deep'), { recursive: true });
  writeFileSync(
    join(root, '.git', 'config'),
    '[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = git@gitlab.com:team/shop.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[branch "main"]\n\tremote = origin\n',
  );
  assert.equal(findGitRoot(join(root, 'src', 'deep')), root);
  assert.equal(readRemoteUrl(root), 'git@gitlab.com:team/shop.git');
  const p = resolveProject(join(root, 'src', 'deep'));
  assert.equal(p.id, 'git:gitlab.com/team/shop');
  assert.equal(p.name, 'shop');
  assert.equal(p.root, root);
});

test('resolveProject falls back to the repo path without a remote', () => {
  const root = join(tmp, 'no-remote');
  mkdirSync(join(root, '.git'), { recursive: true });
  writeFileSync(join(root, '.git', 'config'), '[core]\n\tbare = false\n');
  const p = resolveProject(root);
  assert.ok(p.id.startsWith('path:'), p.id);
  assert.equal(p.name, 'no-remote');
  assert.equal(p.remote, null);
});

test('resolveProject falls back to cwd outside git', () => {
  const dir = join(tmp, 'plain', 'dir');
  mkdirSync(dir, { recursive: true });
  const p = resolveProject(dir);
  assert.equal(p.root, dir);
  assert.equal(p.name, 'dir');
});

test('resolveProject follows a worktree .git file', () => {
  const main = join(tmp, 'main-repo');
  mkdirSync(join(main, '.git', 'worktrees', 'wt'), { recursive: true });
  writeFileSync(join(main, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/o/r.git\n');
  writeFileSync(join(main, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
  const wt = join(tmp, 'wt');
  mkdirSync(wt, { recursive: true });
  writeFileSync(join(wt, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'wt')}\n`);
  assert.equal(resolveProject(wt).id, 'git:github.com/o/r');
});

test('readHead reads loose refs, packed refs, detached and unborn HEADs', () => {
  const repo = join(tmp, 'head-repo');
  const sha1 = 'a'.repeat(40);
  const sha2 = 'b'.repeat(40);
  mkdirSync(join(repo, '.git', 'refs', 'heads', 'feature'), { recursive: true });

  writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(repo, '.git', 'refs', 'heads', 'main'), `${sha1}\n`);
  assert.deepEqual(readHead(repo), { ref: 'main', sha: sha1 });

  writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/feature/x\n');
  writeFileSync(join(repo, '.git', 'packed-refs'), `# pack-refs with: peeled fully-peeled sorted\n${sha2} refs/heads/feature/x\n^${sha1}\n`);
  assert.deepEqual(readHead(repo), { ref: 'feature/x', sha: sha2 });

  writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/unborn\n');
  assert.deepEqual(readHead(repo), { ref: 'unborn', sha: null });

  writeFileSync(join(repo, '.git', 'HEAD'), `${sha2.toUpperCase()}\n`);
  assert.deepEqual(readHead(repo), { ref: null, sha: sha2 });

  assert.equal(readHead(join(tmp, 'not-a-repo')), null);
  assert.equal(readHead(null), null);
});

test('readCommits walks loose commits from HEAD back to a start time', () => {
  const repo = join(tmp, 'commits-repo');
  const gitDir = join(repo, '.git');
  mkdirSync(gitDir, { recursive: true });
  const t0 = Date.parse('2026-09-23T10:00:00Z');
  const c1 = writeLooseCommit(gitDir, { subject: 'chore: before the session', time: t0 - 3600_000 });
  const c2 = writeLooseCommit(gitDir, { parent: c1, subject: 'feat: stage 0 skeleton', time: t0 + 60_000, body: 'Longer body.' });
  const sig = 'gpgsig -----BEGIN PGP SIGNATURE-----\n \n abc\n -----END PGP SIGNATURE-----\n';
  const c3 = writeLooseCommit(gitDir, { parent: c2, subject: 'feat: этап 1, контент-модель', time: t0 + 120_000, extraHeader: sig });

  assert.deepEqual(
    readCommits(repo, c3, { since: t0 }).map((c) => [c.sha, c.subject, c.time]),
    [
      [c2, 'feat: stage 0 skeleton', t0 + 60_000],
      [c3, 'feat: этап 1, контент-модель', t0 + 120_000],
    ],
  );
  assert.equal(readCommits(repo, c3).length, 3, 'no start time: the whole loose chain');
  assert.deepEqual(readCommits(repo, c3, { max: 1 }).map((c) => c.sha), [c3]);

  // A packed (or missing) object ends the walk without an error.
  const c4 = writeLooseCommit(gitDir, { parent: 'f'.repeat(40), subject: 'after gc', time: t0 + 180_000 });
  assert.deepEqual(readCommits(repo, c4, { since: t0 }).map((c) => c.subject), ['after gc']);
  assert.deepEqual(readCommits(repo, 'e'.repeat(40)), []);
  assert.deepEqual(readCommits(repo, null), []);
  assert.deepEqual(readCommits(join(tmp, 'not-a-repo'), c3), []);
});

test('objectLookup finds loose objects and objects in a v2 pack index', () => {
  const repo = join(tmp, 'lookup-repo');
  const objects = join(repo, '.git', 'objects');
  mkdirSync(join(objects, 'ab'), { recursive: true });
  mkdirSync(join(objects, 'pack'), { recursive: true });
  writeFileSync(join(objects, 'ab', 'cdef'.padEnd(38, '0')), '');

  // Minimal v2 .idx: magic, version, fanout[256], sorted 20-byte names.
  const names = ['0011'.padEnd(40, '2'), '7a7a'.padEnd(40, '1'), '7a7b'.padEnd(40, '0'), 'ff00'.padEnd(40, '9')].sort();
  const fanout = Buffer.alloc(256 * 4);
  for (let b = 0; b < 256; b++) fanout.writeUInt32BE(names.filter((n) => parseInt(n.slice(0, 2), 16) <= b).length, b * 4);
  const idx = Buffer.concat([Buffer.from([0xff, 0x74, 0x4f, 0x63, 0, 0, 0, 2]), fanout, ...names.map((n) => Buffer.from(n, 'hex'))]);
  writeFileSync(join(objects, 'pack', 'pack-1.idx'), idx);

  const has = objectLookup(repo);
  assert.equal(has('abcdef0'), true, 'loose');
  for (const n of names) assert.equal(has(n.slice(0, 7)), true, `packed ${n}`);
  assert.equal(has('7a7c000'), false);
  assert.equal(has('abcdee0'), false);
  assert.equal(has('not-hex'), false);
  assert.equal(objectLookup(join(tmp, 'not-a-repo')), null);
});

test('readHead in a worktree uses its own HEAD and the shared refs', () => {
  const main = join(tmp, 'main-repo2');
  const wtGit = join(main, '.git', 'worktrees', 'wt2');
  mkdirSync(wtGit, { recursive: true });
  mkdirSync(join(main, '.git', 'refs', 'heads'), { recursive: true });
  writeFileSync(join(wtGit, 'commondir'), '../..\n');
  writeFileSync(join(wtGit, 'HEAD'), 'ref: refs/heads/topic\n');
  writeFileSync(join(main, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(main, '.git', 'refs', 'heads', 'topic'), `${'c'.repeat(40)}\n`);
  const wt = join(tmp, 'wt2');
  mkdirSync(wt, { recursive: true });
  writeFileSync(join(wt, '.git'), `gitdir: ${wtGit}\n`);
  assert.deepEqual(readHead(wt), { ref: 'topic', sha: 'c'.repeat(40) });
});
