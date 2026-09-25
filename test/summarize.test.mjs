import assert from 'node:assert/strict';
import { test } from 'node:test';
import { briefText, commandHead, commitsFromBash, commitWindows, displayPath, isDocPath, summarize } from '../src/summarize.mjs';
import { parseTranscript } from '../src/transcript.mjs';
import { bash, commitSession, PROJ, sampleSession, toJsonl, toolUse, under } from './helpers.mjs';

const project = { id: 'path:c:/proj', root: PROJ, name: 'proj' };
const WIN = process.platform === 'win32';

test('summarize produces an index-level summary and structured details', () => {
  const t = parseTranscript(toJsonl(sampleSession()));
  const r = summarize(t, project);

  assert.equal(r.title, 'Login bug fix');
  assert.match(r.summary, /Login bug fix/);
  assert.doesNotMatch(r.summary, /prompts|tool calls/);
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
  assert.equal(r.summary, '');
  assert.equal(r.files.length, 0);
});

test('displayPath relativises to the project root or home', () => {
  if (WIN) {
    assert.equal(displayPath('C:\\proj\\src\\a.ts', 'C:\\proj', 'C:\\Users\\me'), 'src/a.ts');
    assert.equal(displayPath('C:\\Users\\me\\.claude\\x.md', 'C:\\proj', 'C:\\Users\\me'), '~/.claude/x.md');
    assert.equal(displayPath('D:\\other\\b.ts', 'C:\\proj', 'C:\\Users\\me'), 'D:/other/b.ts');
    assert.equal(displayPath('rel/c.ts', 'C:\\proj', 'C:\\Users\\me'), 'rel/c.ts');
  } else {
    assert.equal(displayPath('/proj/src/a.ts', '/proj', '/home/me'), 'src/a.ts');
    assert.equal(displayPath('/home/me/.claude/x.md', '/proj', '/home/me'), '~/.claude/x.md');
    assert.equal(displayPath('/other/b.ts', '/proj', '/home/me'), '/other/b.ts');
    assert.equal(displayPath('rel/c.ts', '/proj', '/home/me'), 'rel/c.ts');
  }
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

test('summarize records commits, amends and edits after the last commit', () => {
  const t = parseTranscript(toJsonl(commitSession()));
  const r = summarize(t, project, { head: { ref: 'main', sha: '3333333aaaabbbbccccddddeeeeffff000011112' } });

  assert.deepEqual(
    r.details.commits.map((c) => [c.sha, c.subject, c.branch]),
    [
      ['1111111', 'feat: stage 0 skeleton', 'main'],
      ['3333333', 'feat: stage 1 content model', 'main'],
    ],
    'amend replaces, failed and non-git output are ignored',
  );
  assert.equal(r.stats.commits, 2);
  assert.deepEqual(r.details.git.head, { ref: 'main', sha: '3333333aaaabbbbccccddddeeeeffff000011112' });
  assert.deepEqual(r.details.git.editedAfterLastCommit, ['README.md'], 'sensitive files stay out');

  assert.match(r.summary, /commits: 3333333 feat: stage 1 content model, 1111111 feat: stage 0 skeleton/);
  assert.match(r.summary, /HEAD 3333333/);
  assert.match(r.summary, /docs: docs\/ARCHITECTURE\.md, README\.md/);
  assert.match(r.summary, /edited: src\/a\.ts, src\/b\.ts/);
  assert.doesNotMatch(r.summary, /ran:|outcome:/, 'commits replace commands and outcome');
  assert.ok(r.details.outcome, 'outcome is still stored for search');
});

test('summarize merges commits read from .git with those seen in the transcript', () => {
  // `git commit -q && git log --oneline`: the commit happened, but no `[branch sha]` line.
  const t = parseTranscript(toJsonl([...commitSession(), ...bash('git commit -qam "docs: readme" && git log --oneline -1', 'ccccccc docs: readme')]));
  const quietCall = t.toolUses[t.toolUses.length - 1];
  const full3 = '3333333'.padEnd(40, 'a');
  const quiet = 'c'.repeat(40);
  const r = summarize(t, project, {
    head: { ref: 'main', sha: quiet },
    headCommits: [
      { sha: full3, subject: 'feat: stage 1 content model', time: Date.parse(t.toolUses[6].ts) },
      { sha: quiet, subject: 'docs: readme', time: Date.parse(quietCall.ts) + 500 },
    ],
  });
  assert.deepEqual(
    r.details.commits.map((c) => [c.sha.slice(0, 7), c.subject]),
    [
      ['1111111', 'feat: stage 0 skeleton'],
      ['3333333', 'feat: stage 1 content model'],
      ['ccccccc', 'docs: readme'],
    ],
    'no duplicate for a commit seen both ways',
  );
  assert.deepEqual(r.details.git.editedAfterLastCommit, [], 'the quiet commit covers the README edit');
});

test('commits on HEAD made outside this session\'s own git calls are not attributed to it', () => {
  // Two sessions in parallel on one branch: HEAD carries both sessions' commits.
  const t = parseTranscript(toJsonl([...commitSession(), ...bash('git commit -qam "mine"', '')]));
  const mine = t.toolUses[t.toolUses.length - 1];
  const r = summarize(t, project, {
    headCommits: [
      { sha: 'a'.repeat(40), subject: 'other session', time: Date.parse(mine.ts) - 60_000 },
      { sha: 'b'.repeat(40), subject: 'mine', time: Date.parse(mine.resultTs) },
      { sha: 'd'.repeat(40), subject: 'typed in a terminal later', time: Date.parse(mine.resultTs) + 60_000 },
    ],
  });
  assert.deepEqual(r.details.commits.map((c) => c.subject).slice(-1), ['mine']);
  assert.ok(!r.details.commits.some((c) => /other|terminal/.test(c.subject)));
});

test('commitWindows spans each committing git call from request to result', () => {
  const t = parseTranscript(toJsonl([...bash('git status', ''), ...bash('npm test && git commit -m x', '[m 1234567] x'), ...bash('git push', 'ok')]));
  const w = commitWindows(t.toolUses);
  assert.equal(w.length, 1);
  assert.equal(w[0][0], Date.parse(t.toolUses[1].ts) - 2000);
  assert.equal(w[0][1], Date.parse(t.toolUses[1].resultTs) + 2000);
});

test('summarize drops transcript commits that are not in this repository', () => {
  const t = parseTranscript(toJsonl(commitSession()));
  const r = summarize(t, project, { commitExists: (sha) => sha.startsWith('333') });
  assert.deepEqual(r.details.commits.map((c) => c.sha), ['3333333'], '1111111 was committed in another repo');
});

test('summarize without commits keeps outcome and makes no claim about the tree', () => {
  const r = summarize(parseTranscript(toJsonl(sampleSession())), project, { head: { ref: 'main', sha: 'a'.repeat(40) } });
  assert.deepEqual(r.details.commits, []);
  assert.equal(r.details.git.editedAfterLastCommit, null);
  assert.equal(summarize(parseTranscript(''), project).details.git.head, null);
});

test('commitsFromBash only trusts git commands', () => {
  assert.deepEqual(commitsFromBash('git cherry-pick x', '[detached HEAD abcdef1] fix it'), [{ sha: 'abcdef1', subject: 'fix it', branch: null }]);
  assert.deepEqual(commitsFromBash('cat log.txt', '[main abcdef1] fix it'), []);
  assert.deepEqual(commitsFromBash('git commit -m x', 'nothing to commit, working tree clean'), []);
  assert.equal(commitsFromBash('git commit -m x', '[feature/x 1234567] add token=ghp_abcdefghijklmnopqrstuvwxyz0123456789')[0].branch, 'feature/x');
  assert.doesNotMatch(commitsFromBash('git commit', '[m 1234567] ghp_abcdefghijklmnopqrstuvwxyz0123456789')[0].subject, /ghp_/);
});

test('isDocPath marks docs/ and prose files inside the project only', () => {
  for (const p of ['docs/a.ts', 'README.md', 'x/y/ARCHITECTURE.MD', 'guide.rst', 'doc/notes.txt']) assert.ok(isDocPath(p), p);
  for (const p of ['src/md.ts', 'mydocs/a.ts', 'a.mdx.ts', '~/.claude/projects/x/memory/MEMORY.md', 'D:/other/README.md']) assert.ok(!isDocPath(p), p);
});

test('files outside the project never count as edited after the last commit', () => {
  const t = parseTranscript(
    toJsonl([
      ...commitSession(),
      toolUse('Write', { file_path: WIN ? 'C:\\Users\\me\\.claude\\projects\\p\\memory\\MEMORY.md' : '/home/me/.claude/projects/p/memory/MEMORY.md', content: 'x' }, { sessionId: 'sess-c' }),
    ]),
  );
  const r = summarize(t, project, {});
  assert.deepEqual(r.details.git.editedAfterLastCommit, ['README.md']);
  assert.ok(r.details.filesEdited.some((p) => p.endsWith('MEMORY.md')), 'still listed as an edited file');
  assert.doesNotMatch(r.summary, /docs: [^·]*MEMORY/);
});

test('briefText drops markup and cuts at a sentence boundary', () => {
  assert.equal(briefText('## Done\n\nStage 1 is **committed**. See [PLAN](PLAN.md).\n\n| a | b |\n\n```js\nx()\n```', 200), 'Done Stage 1 is committed. See PLAN.');
  assert.equal(briefText('First sentence is here. Second one is much longer and gets cut somewhere', 40), 'First sentence is here.');
  assert.equal(briefText('no sentence boundary at all in this long text', 20), 'no sentence…');
  assert.ok(briefText('x'.repeat(50), 20).length <= 20);
});

test('a failed Edit changes nothing and is not counted', () => {
  const t = parseTranscript(toJsonl(sampleSession()));
  for (const u of t.toolUses) if (u.name === 'Edit') u.isError = true;
  const r = summarize(t, project);
  assert.deepEqual(r.details.filesEdited, ['test/auth.test.ts'], 'src/auth.ts was only read, its edit failed');
});

test('summarize stores segments, rework and the details format', () => {
  const r = summarize(parseTranscript(toJsonl(commitSession())), project, { worktree: { clean: true, count: 0, paths: [], hidden: 0 } });
  assert.equal(r.details.format, 3);
  assert.deepEqual(r.details.segments.map((g) => g.commit?.sha ?? 'open'), ['1111111', '3333333', 'open']);
  assert.deepEqual(r.details.segments[2].files.map((f) => f.path), ['README.md'], '.env never appears');
  assert.deepEqual(r.details.git.worktree, { clean: true, count: 0, paths: [], hidden: 0 });
  assert.deepEqual(r.details.rework, []);
});

test('a file edited before the last commit but left out of it moves to the uncommitted tail', () => {
  // Both files written first, then only one committed: `git status` shows the other.
  const r = summarize(parseTranscript(toJsonl([
    toolUse('Write', { file_path: under(PROJ, 'a.md'), content: 'a' }),
    toolUse('Write', { file_path: under(PROJ, 'b.md'), content: 'b' }),
    ...bash('git add a.md && git commit -m "docs: first file"', '[master 622b41f] docs: first file'),
  ])), project, { worktree: { clean: false, count: 1, paths: ['b.md'], hidden: 0 } });
  assert.deepEqual(
    r.details.segments.map((g) => [g.commit?.sha ?? 'open', g.files.map((f) => f.path)]),
    [
      ['622b41f', ['a.md']],
      ['open', ['b.md']],
    ],
  );
});
