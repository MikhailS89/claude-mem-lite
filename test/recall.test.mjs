import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatSessionBrief } from '../src/recall.mjs';
import { summarize } from '../src/summarize.mjs';
import { parseTranscript } from '../src/transcript.mjs';
import { commitSession, toJsonl } from './helpers.mjs';

const project = { id: 'path:c:/proj', root: 'C:\\proj', name: 'proj' };
const HEAD = { ref: 'main', sha: '3333333'.padEnd(40, '0') };

function row(details, extra = {}) {
  return {
    id: 'fff69b35-0000',
    started_at: '2026-09-22T11:20:00Z',
    updated_at: '2026-09-22T12:00:00Z',
    branch: 'main',
    title: 'Stage 1',
    status: 'ended',
    prompts: 24,
    tool_calls: 349,
    details: JSON.stringify(details),
    ...extra,
  };
}

test('recap leads with commits and git state, without activity counters', () => {
  const { details } = summarize(parseTranscript(toJsonl(commitSession())), project, { head: HEAD });
  const out = formatSessionBrief(row(details));

  assert.match(out, /- commits:\n {2}- 1111111 feat: stage 0 skeleton\n {2}- 3333333 feat: stage 1 content model/);
  assert.match(out, /- HEAD at end: 3333333 \(main\) · edited after last commit: README\.md/);
  assert.match(out, /- docs changed: docs\/ARCHITECTURE\.md, README\.md\n- edited: src\/a\.ts, src\/b\.ts/);
  assert.match(out, /- session: fff69b35$/);
  assert.doesNotMatch(out, /prompts|tool calls|ran:|outcome:/);
  assert.ok(out.indexOf('commits') < out.indexOf('HEAD') && out.indexOf('HEAD') < out.indexOf('docs changed'));
});

test('recap says when HEAD moved since the session', () => {
  const { details } = summarize(parseTranscript(toJsonl(commitSession())), project, { head: HEAD });
  assert.match(formatSessionBrief(row(details), { currentHead: HEAD }), /HEAD at end: 3333333 \(main\) ·/);
  assert.match(
    formatSessionBrief(row(details), { currentHead: { ref: 'feature', sha: 'd'.repeat(40) } }),
    /HEAD at end: 3333333 \(main\), now ddddddd \(feature\)/,
  );
});

test('recap caps the commit list and keeps the newest', () => {
  const commits = Array.from({ length: 11 }, (_, i) => ({ sha: String(i).padStart(7, '0'), subject: `c${i}`, branch: 'main' }));
  const out = formatSessionBrief(row({ commits, git: { head: null, editedAfterLastCommit: [] } }));
  assert.match(out, /- commits \(last 8 of 11\):/);
  assert.ok(!out.includes(' c2\n') && out.includes(' c10'));
  assert.match(out, /no edits after last commit/);
});

test('recap without commits keeps ran and a cleaned-up outcome', () => {
  const out = formatSessionBrief(
    row({
      filesEdited: ['PLAN.md'],
      commands: ['npm test'],
      prompts: [{ ts: '', text: 'Понял, спасибо' }],
      outcome: '**Пожалуйста.** Перезапустите VS Code — и можно начинать. Если что-то не так, смотрите `hooks.log`.',
      git: { head: { ref: 'main', sha: 'e'.repeat(40) }, editedAfterLastCommit: null },
      commits: [],
    }),
  );
  assert.match(out, /- HEAD at end: eeeeeee \(main\)\n/);
  assert.doesNotMatch(out, /after last commit/, 'no claim about the working tree without a commit');
  assert.match(out, /- docs changed: PLAN\.md/);
  assert.match(out, /- ran: npm test/);
  assert.match(out, /- outcome: Пожалуйста\. Перезапустите VS Code — и можно начинать\. Если что-то не так, смотрите hooks\.log\./);
});

test('rows written before git state was recorded still render', () => {
  const out = formatSessionBrief(
    row({
      title: 'PLAN.md review',
      prompts: [{ ts: '', text: 'Понял, спасибо' }],
      filesEdited: ['package.json', 'src/config.mjs'],
      commands: ['npm test', 'git commit -m x'],
      tools: { Bash: 3, Read: 6 },
      outcome: 'Пожалуйста.',
    }),
    { currentHead: HEAD },
  );
  assert.equal(
    out,
    [
      '### ' + out.split('\n')[0].slice(4),
      '- edited: package.json, src/config.mjs',
      '- ran: npm test, git commit',
      '- last request: Понял, спасибо',
      '- outcome: Пожалуйста.',
      '- session: fff69b35',
    ].join('\n'),
  );
  assert.equal(formatSessionBrief(row({}, { details: 'not json' })).split('\n').length, 2);
});
