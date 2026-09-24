// Heuristic (no LLM) compression of a parsed transcript into:
//   - `summary`: one short paragraph, the "index level" shown on SessionStart
//   - `details`: structured JSON, the "detail level" returned by `show`
//   - `files`:   per-file touch counts for the session_files table

import { homedir } from 'node:os';
import { isAbsolute, relative } from 'node:path';
import { limits } from './config.mjs';
import { isSensitivePath, safeSlice, sanitize, truncate } from './privacy.mjs';
import { buildSegments, removalsFromCommand } from './segments.mjs';
import { describeToolUse } from './transcript.mjs';

/** Version of the `details` JSON; bump when old rows should be re-indexed. */
export const DETAILS_FORMAT = 3;

/**
 * Make a path relative to the project root (or `~` for the home directory)
 * and use forward slashes.
 */
export function displayPath(filePath, projectRoot, home = homedir()) {
  let p = String(filePath);
  if (isAbsolute(p)) {
    const relProject = projectRoot ? relative(projectRoot, p) : '';
    const relHome = home ? relative(home, p) : '';
    if (relProject && !relProject.startsWith('..') && !isAbsolute(relProject)) p = relProject;
    else if (relHome && !relHome.startsWith('..') && !isAbsolute(relHome)) p = '~/' + relHome;
  }
  return p.replace(/\\/g, '/');
}

/** Dedupe a list of strings preserving first occurrence order. */
function uniq(list) {
  return [...new Set(list)];
}

/**
 * `git commit` (and cherry-pick / revert / merge) print one line per new
 * commit: `[main 542b65e] subject`, `[main (root-commit) 542b65e] subject`,
 * `[detached HEAD 542b65e] subject`.
 */
const COMMIT_LINE = /^\[(.+?) ([0-9a-f]{7,64})\] (.+)$/gm;

/**
 * Commits a single Bash call made, read from its output. Only calls that ran
 * `git` count, so printing a file that happens to contain such a line does not.
 * @returns {{sha:string, subject:string, branch:string|null}[]}
 */
export function commitsFromBash(command, result) {
  if (!result || !/\bgit\b/.test(command ?? '')) return [];
  const out = [];
  for (const m of String(result).matchAll(COMMIT_LINE)) {
    const branch = m[1].replace(/\s*\(root-commit\)$/, '').trim();
    out.push({ sha: m[2].toLowerCase(), subject: truncate(sanitize(m[3]), 120), branch: /^detached HEAD\b/.test(branch) ? null : branch });
  }
  return out;
}

/** git subcommands that create commits. */
const COMMITTING_GIT = /\bgit\b[^\n]*?\b(commit|merge|cherry-pick|revert|rebase|am|pull)\b/;

/** Git commits carry whole seconds; the transcript has milliseconds. */
const WINDOW_SLACK_MS = 2000;

/**
 * Time windows [from, to] (ms) in which this session's own git commands that
 * can create commits were running: from the tool call to its result.
 */
export function commitWindows(toolUses) {
  const out = [];
  for (const u of toolUses) {
    if (u.name !== 'Bash' || u.isError || !COMMITTING_GIT.test(u.input?.command ?? '')) continue;
    const from = Date.parse(u.ts);
    const to = Date.parse(u.resultTs ?? u.ts);
    if (Number.isFinite(from) && Number.isFinite(to)) out.push([from - WINDOW_SLACK_MS, to + WINDOW_SLACK_MS]);
  }
  return out;
}

/** A display path inside the project (not `~/...` or another absolute path). */
export function isProjectPath(p) {
  return pathRank(p) === 0;
}

/**
 * Project files under `docs/` and prose files: edits there usually record a
 * decision. Files outside the repository (Claude's own notes, other repos)
 * are not project docs and cannot be committed here.
 */
export function isDocPath(p) {
  return isProjectPath(p) && (/(^|\/)docs?\//i.test(p) || /\.(md|mdx|markdown|rst|adoc)$/i.test(p));
}

/**
 * @param {import('./transcript.mjs').ParsedTranscript} t
 * @param {{root: string}} project
 * @param {object} [opts] everything read from the repository by the caller:
 * @param {{ref: string|null, sha: string|null}|null} [opts.head]  HEAD at capture time
 * @param {{sha:string, subject:string, time:number}[]} [opts.headCommits]  commits on HEAD since the session started
 * @param {((sha:string) => boolean)|null} [opts.commitExists]  does a commit seen in the transcript belong to this repo
 * @param {{clean:boolean, count:number, paths:string[]}|null} [opts.worktree]  `git status` at capture time, if known
 */
export function summarize(t, project, { head = null, headCommits = [], commitExists = null, worktree = null } = {}) {
  const root = project?.root ?? null;

  // --- files, commands, commits ----------------------------------------------
  /** @type {Map<string, {path:string, kind:string, ops:number}>} */
  const files = new Map();
  const commands = [];
  const searches = [];
  const tools = {};
  /** @type {{sha:string, subject:string, branch:string|null, ts:string}[]} */
  const commits = [];
  /** Every edit with its time: segments, rework, edits after the last commit. */
  const edits = [];
  /** Files removed or discarded by Bash commands, for rework detection. */
  const removals = [];
  let sensitiveTouches = 0;

  for (const use of t.toolUses) {
    tools[use.name] = (tools[use.name] ?? 0) + 1;
    const d = describeToolUse(use.name, use.input);
    if (d.file) {
      if (isSensitivePath(d.file.path)) {
        sensitiveTouches++;
        continue;
      }
      // A failed Edit/Write ("string not found") changed nothing.
      if (d.file.kind !== 'read' && use.isError) continue;
      const key = displayPath(d.file.path, root);
      const cur = files.get(key) ?? { path: key, kind: 'read', ops: 0 };
      cur.ops++;
      // edit/write outranks read
      if (d.file.kind !== 'read') {
        cur.kind = cur.kind === 'read' ? d.file.kind : cur.kind;
        edits.push({ path: key, kind: d.file.kind, ms: Date.parse(use.ts), project: isProjectPath(key), doc: isDocPath(key) });
      }
      files.set(key, cur);
    } else if (d.command) {
      commands.push(truncate(sanitize(d.command), limits.commandChars));
      if (!use.isError) {
        const ms = Date.parse(use.ts);
        for (const r of removalsFromCommand(d.command, t.cwd || root || '.', (abs) => displayPath(abs, root))) removals.push({ ...r, ms });
      }
      // Output alone does not say which repository the commit was made in.
      const made = (use.isError ? [] : commitsFromBash(d.command, use.result)).filter((c) => !commitExists || commitExists(c.sha));
      if (made.length) {
        // `--amend` rewrites the previous commit instead of adding one.
        if (/--amend\b/.test(d.command) && commits.length) commits.pop();
        for (const c of made) {
          const dup = commits.findIndex((x) => x.sha === c.sha);
          if (dup !== -1) commits.splice(dup, 1);
          commits.push({ ...c, ts: use.ts });
        }
      }
    } else if (d.search) {
      searches.push(truncate(sanitize(d.search), 80));
    }
  }

  // Commits on HEAD read from `.git` catch what the transcript output cannot
  // show (`git commit -q`, output replaced by `git log`). But HEAD also carries
  // commits from parallel sessions and from a terminal, so one is attributed to
  // this session only if it was made while one of its own committing git
  // commands was running.
  const windows = commitWindows(t.toolUses);
  for (const c of headCommits) {
    if (!windows.some(([from, to]) => c.time >= from && c.time <= to)) continue;
    if (commits.some((x) => c.sha.startsWith(x.sha) || x.sha.startsWith(c.sha))) continue;
    commits.push({ sha: c.sha, subject: truncate(sanitize(c.subject), 120), branch: head?.ref ?? null, ts: new Date(c.time).toISOString() });
  }
  commits.sort((a, b) => (Date.parse(a.ts) || 0) - (Date.parse(b.ts) || 0)); // stable: ties keep order
  const lastCommitMs = commits.length ? Math.max(...commits.map((c) => Date.parse(c.ts) || 0)) : null;

  // Project-relative paths first, then `~/...`, then anything else absolute.
  const fileList = [...files.values()].sort((a, b) => pathRank(a.path) - pathRank(b.path));
  const edited = fileList.filter((f) => f.kind !== 'read').map((f) => f.path);
  const read = fileList.filter((f) => f.kind === 'read').map((f) => f.path);

  // --- prompts & outcome -----------------------------------------------------
  const prompts = t.prompts
    .map((p) => ({ ts: p.ts, text: truncate(sanitize(p.text), limits.promptChars) }))
    .filter((p) => p.text && p.text !== '[private]');
  const outcome = t.assistantTexts.length
    ? truncate(sanitize(t.assistantTexts[t.assistantTexts.length - 1].text), limits.outcomeChars)
    : '';

  const firstPrompt = prompts[0]?.text ?? '';
  const lastPrompt = prompts[prompts.length - 1]?.text ?? '';
  const title = t.title ? truncate(sanitize(t.title), 120) : truncate(firstPrompt, 80);

  // --- stats -----------------------------------------------------------------
  const durationMin =
    t.startedAt && t.endedAt ? Math.max(0, Math.round((Date.parse(t.endedAt) - Date.parse(t.startedAt)) / 60000)) : null;
  const stats = {
    prompts: t.prompts.length,
    toolCalls: t.toolUses.length,
    filesEdited: edited.length,
    filesRead: read.length,
    commands: commands.length,
    durationMin,
    commits: commits.length,
    sensitiveTouches,
  };

  // --- git state at the end of the session -----------------------------------
  const git = {
    head: head && (head.sha || head.ref) ? { ref: head.ref ?? null, sha: head.sha ?? null } : null,
    // Only meaningful relative to a commit made in this session. These are
    // Claude's own edits: changes made outside the session are invisible here,
    // so this is never a claim that the working tree is clean.
    editedAfterLastCommit:
      lastCommitMs === null
        ? null
        : uniq(edits.filter((e) => e.project && e.ms > lastCommitMs).map((e) => e.path)).slice(0, limits.files),
    // `git status` when the session last saved: the authoritative answer to
    // "is anything uncommitted", including edits made outside the session.
    worktree,
  };

  // --- segments between commits, and what did not settle ---------------------
  const { segments, rework } = buildSegments(
    {
      edits,
      prompts: prompts.map((p) => ({ text: p.text, ms: Date.parse(p.ts) })),
      commits: commits.map((c) => ({ sha: c.sha, subject: c.subject, ms: Date.parse(c.ts) })),
      removals,
      activity: t.toolUses.map((u) => [Date.parse(u.ts), Date.parse(u.resultTs ?? u.ts)]),
      startedAt: t.startedAt,
      endedAt: t.endedAt,
    },
    { maxPrompts: 10, maxFiles: 60 },
  );

  // --- index-level summary ---------------------------------------------------
  const parts = [];
  if (title) parts.push(title);
  if (commits.length) parts.push(`commits: ${listPreview(commits.map((c) => `${c.sha.slice(0, 7)} ${c.subject}`).reverse(), 3)}`);
  if (git.head?.sha) parts.push(`HEAD ${git.head.sha.slice(0, 7)}`);
  const docs = edited.filter(isDocPath);
  if (docs.length) parts.push(`docs: ${listPreview(docs, 4)}`);
  const code = edited.filter((p) => !isDocPath(p));
  if (code.length) parts.push(`edited: ${listPreview(code, 6)}`);
  else if (!edited.length && read.length) parts.push(`read: ${listPreview(read, 4)}`);
  const cmdPreview = uniq(commands.map(commandHead)).filter(Boolean);
  if (cmdPreview.length && !commits.length) parts.push(`ran: ${listPreview(cmdPreview, 5)}`);
  if (lastPrompt && lastPrompt !== firstPrompt) parts.push(`last request: "${truncate(lastPrompt, 140)}"`);
  else if (firstPrompt && !t.title) parts.push(`request: "${truncate(firstPrompt, 140)}"`);
  const undone = rework.filter((r) => r.reason !== 'revisited');
  if (undone.length) parts.push(`undone: ${listPreview(undone.map((r) => r.path), 3)}`);
  if (outcome && !commits.length) parts.push(`outcome: "${briefText(outcome, 200)}"`);
  const summary = parts.join(' · ');

  const details = {
    // Rows without `format` were written before segments existed (0.1 / 0.2).
    format: DETAILS_FORMAT,
    title,
    prompts: prompts.slice(-limits.prompts),
    filesEdited: edited.slice(0, limits.files),
    filesRead: read.slice(0, limits.files),
    commands: uniq(commands).slice(-limits.commands),
    searches: uniq(searches).slice(0, 20),
    commits: commits.slice(-limits.commits),
    git,
    segments,
    rework,
    tools,
    outcome,
    stats,
  };

  return { title, summary, details, files: fileList.slice(0, limits.files), stats };
}

/**
 * Shorten an assistant message for display: drop code blocks, tables and
 * markdown markup, then cut at a sentence boundary rather than mid-phrase.
 */
export function briefText(text, max) {
  let s = String(text ?? '')
    .replace(/```[\s\S]*?(```|$)/g, ' ') // fenced code (also an unclosed one)
    .split(/\r?\n/)
    .filter((line) => !/^\s*\|/.test(line)) // table rows
    .map((line) => line.replace(/^\s*#{1,6}\s+/, '').replace(/^\s*(?:[-*+]|\d+\.)\s+/, ''))
    .join('\n')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // [text](link)
    .replace(/(\*\*|__|`)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length <= max) return s;
  const head = safeSlice(s, max);
  let cut = -1;
  for (const m of head.matchAll(/[.!?…](?=\s)/g)) cut = m.index + 1;
  if (cut >= max * 0.4) return head.slice(0, cut);
  s = safeSlice(head, max - 1);
  const space = s.lastIndexOf(' ');
  return (space > max * 0.4 ? s.slice(0, space) : s).trimEnd() + '…';
}

/** "npm test", "git commit", "node scripts/x.mjs" - the first one or two words of a command. */
export function commandHead(cmd) {
  let s = String(cmd).trim();
  s = s.replace(/^[(\s]+/, ''); // subshell "(a; b)"
  s = s.replace(/^(cd\s+("[^"]*"|'[^']*'|\S+)\s*(&&|;)\s*)+/, ''); // "cd <dir> && ..."
  s = s.replace(/^(\w+=("[^"]*"|'[^']*'|\S+)\s+)+/, ''); // "FOO=bar cmd"
  const words = s.split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  const first = words[0].replace(/^.*[\\/]/, '');
  const subcommandTools = new Set(['git', 'npm', 'pnpm', 'yarn', 'bun', 'docker', 'cargo', 'go', 'dotnet', 'pip', 'python', 'node', 'make', 'gh', 'kubectl', 'composer', 'php']);
  if (subcommandTools.has(first) && words[1] && !words[1].startsWith('-')) return `${first} ${words[1]}`;
  return first;
}

function pathRank(p) {
  if (p.startsWith('~/')) return 1;
  if (isAbsolute(p) || /^[a-z]:\//i.test(p)) return 2;
  return 0;
}

function listPreview(items, max) {
  const shown = items.slice(0, max).join(', ');
  return items.length > max ? `${shown} (+${items.length - max})` : shown;
}
