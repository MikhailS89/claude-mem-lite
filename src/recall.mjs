// Builds the short recap injected on SessionStart. This is the "index level"
// of progressive disclosure: a handful of one-paragraph session summaries,
// hard-capped in size. Full details are only fetched on demand via the
// mem-search skill / CLI.

import { existsSync } from 'node:fs';
import { dbPath, enabled, isDisabledForProject, recallMaxChars, recallSessions } from './config.mjs';
import { MemoryDb } from './db.mjs';
import { bmpSafe, safeSlice, truncate } from './privacy.mjs';
import { findGitRoot, readHead, resolveProject } from './project.mjs';
import { briefText, commandHead, isDocPath, isProjectPath } from './summarize.mjs';

/** Format an ISO timestamp as `YYYY-MM-DD HH:MM` in local time. */
export function fmtTime(iso) {
  if (!iso) return '?';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '?';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * "7d", "24h", "2w" (relative to now) or a date "2026-09-01" -> ISO timestamp,
 * for `--since`. Throws on anything else, so a typo never silently means
 * "no filter".
 */
export function parseSince(value, now = Date.now()) {
  const v = String(value ?? '').trim();
  const rel = /^(\d+)\s*([hdw])$/i.exec(v);
  if (rel) {
    const unit = { h: 3600e3, d: 86400e3, w: 7 * 86400e3 }[rel[2].toLowerCase()];
    return new Date(now - Number(rel[1]) * unit).toISOString();
  }
  const t = Date.parse(v);
  if (/^\d{4}-\d{2}-\d{2}/.test(v) && Number.isFinite(t)) return new Date(t).toISOString();
  throw new Error(`--since expects 24h, 7d, 2w or a date like 2026-09-01, got "${v}"`);
}

/**
 * A session without a SessionEnd record may still be open in another
 * terminal, or SessionEnd simply never fired (e.g. `claude -p`). Only call it
 * "unfinished" while it was updated recently.
 */
export function isLikelyOpen(s, now = Date.now()) {
  if (s.status !== 'active') return false;
  const t = Date.parse(s.updated_at ?? '');
  return Number.isFinite(t) && now - t < 2 * 60 * 60 * 1000;
}

/** Commits shown per session in rows written before segments existed. */
const RECAP_COMMITS = 8;
/** Segments listed for the newest session, and for each older one. */
const SEGMENTS_NEWEST = 6;
const SEGMENTS_OLDER = 2;

/**
 * One session -> a few lines of markdown, leading with state: where HEAD was
 * left and whether anything is uncommitted, then the units of work (one per
 * commit, oldest first), the docs that changed, and what did not settle.
 * Rows written before segments existed are rendered by formatLegacyBrief.
 * @param {object} s session row
 * @param {{currentHead?: {ref:string|null, sha:string|null}|null, newest?: boolean, notes?: Map<string, {why:string}>}} [opts]
 *        currentHead: HEAD of the repository now, to tell whether it moved since;
 *        newest: the first session of the recap, shown in more detail;
 *        notes: commit notes by sha, whose "why" is shown under the newest session's commits
 */
export function formatSessionBrief(s, { currentHead = null, newest = true, notes = null } = {}) {
  const d = safeJson(s.details);
  if (!Array.isArray(d.segments)) return formatLegacyBrief(s, d, { currentHead });
  const lines = [sessionHeader(s)];
  const git = d.git ?? null;

  const state = formatHead(git, currentHead);
  if (state) lines.push(`- ${state}`);

  const segs = d.segments;
  const commits = segs.filter((g) => g.commit).length;
  const max = newest ? SEGMENTS_NEWEST : SEGMENTS_OLDER;
  const shown = segs.slice(-max);
  if (commits) {
    const earlier = segs.length - shown.length;
    lines.push(`- work${earlier ? ` (last ${shown.length} of ${segs.length} segments)` : ''}, oldest first:`);
  }
  for (const g of shown) {
    lines.push(`${commits ? '  - ' : '- '}${segmentLine(g, { listFiles: !g.commit })}`);
    // The reason behind a commit is what git does not keep; only the newest
    // session gets it, to keep the recap small.
    const why = newest && g.commit ? statedWhy(notes?.get(g.commit.sha)) : null;
    if (why) lines.push(`    why: ${truncate(why, 220)}`);
  }

  const docs = (d.filesEdited ?? []).filter(isDocPath);
  if (docs.length) lines.push(`- docs changed: ${preview(docs, 6)}`);
  // Only for the newest session: that is where it changes what to do next.
  // `show` lists it for every session.
  if (newest) lines.push(...reworkLines(d.rework ?? [], 3).map((l) => `- ${l}`));

  const prompts = d.prompts ?? [];
  if (prompts.length) lines.push(`- last request: ${truncate(prompts[prompts.length - 1].text, newest ? 200 : 120)}`);
  // Without commits (a discussion, a review) the last answer is the only record of what was agreed.
  if (d.outcome && !commits) lines.push(`- outcome: ${briefText(d.outcome, newest ? 300 : 160)}`);
  lines.push(`- session: ${s.id.slice(0, 8)}${isLikelyOpen(s) ? ' (possibly still open)' : ''}`);
  return lines.join('\n');
}

/** A note's "why", unless the model found no stated reason. */
export function statedWhy(note) {
  const why = note?.why?.trim();
  if (!why || /^(not stated|не указан[оа]?|причина не указана)\.?$/i.test(why)) return null;
  return why;
}

function sessionHeader(s, suffix = '') {
  return [`### ${fmtTime(s.started_at ?? s.updated_at)}`, s.branch ? `· ${s.branch}` : '', s.title ? `· ${s.title}` : '', suffix]
    .filter(Boolean)
    .join(' ');
}

/**
 * "efcceb5 Stage 4: auth · 7 files · 15 min" or "uncommitted · 3 files: a, b, c · 5 min".
 * Counts and lists are project files; edits elsewhere (notes, scratch files)
 * are only counted.
 */
export function segmentLine(g, { listFiles = false } = {}) {
  const all = g.files ?? [];
  const files = all.filter((f) => isProjectPath(f.path));
  const outside = all.length - files.length;
  // An open segment after a commit is known to be uncommitted work; a session
  // with no commits found at all may simply have committed out of our sight
  // (another repo path, a renamed folder), so it claims nothing.
  const parts = [g.commit ? `${g.commit.sha.slice(0, 7)} ${g.commit.subject}` : g.seq > 0 ? 'uncommitted' : 'no commits recorded'];
  if (files.length) {
    const noun = `${files.length} file${files.length === 1 ? '' : 's'}`;
    parts.push(listFiles ? `${noun}: ${preview(files.map((f) => f.path), 6)}` : noun);
  } else if (!g.commit) {
    parts.push('no project file changes');
  }
  if (outside) parts.push(`${outside} outside the project`);
  if (g.activeMin) parts.push(`${g.activeMin} min`);
  return parts.join(' · ');
}

/**
 * Work that did not settle, split by how sure the signal is:
 *   undone:  created then deleted, or edits discarded - certain;
 *   revisited after moving on: came back to after other work - a hint (a
 *   file can also just grow with each feature), so the counts are shown.
 * @returns {string[]} zero, one or two lines
 */
export function reworkLines(rework, max = Infinity) {
  const undone = rework.filter((r) => r.reason !== 'revisited');
  const revisited = rework.filter((r) => r.reason === 'revisited');
  const line = (label, items, text) =>
    items.length ? [`${label}: ${items.slice(0, max).map(text).join('; ')}${items.length > max ? ` (+${items.length - max} more)` : ''}`] : [];
  return [
    ...line('undone', undone, (r) => `${r.path} (${r.reason === 'deleted' ? 'created, then deleted' : 'edits discarded'})`),
    ...line('revisited after moving on', revisited, (r) => `${r.path} (${r.edits} edits in ${r.segments.length} segments)`),
  ];
}

/** Rows written by 0.1 / 0.2: sessions without segments. */
function formatLegacyBrief(s, d, { currentHead }) {
  const lines = [sessionHeader(s, '· legacy record')];
  const commits = d.commits ?? [];
  const git = d.git ?? null;

  if (commits.length) {
    const shown = commits.slice(-RECAP_COMMITS);
    const earlier = commits.length - shown.length;
    lines.push(`- commits${earlier ? ` (last ${shown.length} of ${commits.length})` : ''}:`);
    for (const c of shown) lines.push(`  - ${c.sha.slice(0, 7)} ${c.subject}`);
  }
  const headLine = formatHead(git, currentHead);
  if (headLine) lines.push(`- ${headLine}`);

  const edited = d.filesEdited ?? [];
  const read = d.filesRead ?? [];
  const docs = edited.filter(isDocPath);
  const code = edited.filter((p) => !isDocPath(p));
  if (docs.length) lines.push(`- docs changed: ${preview(docs, 6)}`);
  if (code.length) lines.push(`- edited: ${preview(code, 8)}`);
  if (read.length && !edited.length) lines.push(`- read: ${preview(read, 6)}`);
  const cmds = [...new Set((d.commands ?? []).map(commandHead).filter(Boolean))];
  // With commits, the commit list says what the commands were for.
  if (cmds.length && !commits.length) lines.push(`- ran: ${preview(cmds, 8)}`);
  const prompts = d.prompts ?? [];
  if (prompts.length) lines.push(`- last request: ${truncate(prompts[prompts.length - 1].text, 200)}`);
  // Without commits (a discussion, a review) the last answer is the only record of what was agreed.
  if (d.outcome && !commits.length) lines.push(`- outcome: ${briefText(d.outcome, 300)}`);
  lines.push(`- session: ${s.id.slice(0, 8)}${isLikelyOpen(s) ? ' (possibly still open)' : ''}`);
  return lines.join('\n');
}

/**
 * "HEAD at end: 542b65e (main) · clean", "... · 3 uncommitted: a, b, c".
 * `git status` (worktree) is authoritative when recorded; otherwise fall back
 * to Claude's own edits after its last commit, which says nothing about
 * changes made outside the session.
 */
function formatHead(git, currentHead) {
  if (!git) return '';
  const parts = [];
  const sha = git.head?.sha ?? null;
  if (sha) {
    let s = `HEAD at end: ${sha.slice(0, 7)}`;
    if (git.head.ref) s += ` (${git.head.ref})`;
    // Stored shas may be abbreviated (taken from `git commit` output).
    if (currentHead?.sha && !currentHead.sha.startsWith(sha) && !sha.startsWith(currentHead.sha)) {
      s += `, now ${currentHead.sha.slice(0, 7)}${currentHead.ref && currentHead.ref !== git.head.ref ? ` (${currentHead.ref})` : ''}`;
    }
    parts.push(s);
  }
  const wt = git.worktree;
  if (wt) {
    if (wt.clean) parts.push('clean');
    else {
      const listed = wt.paths.length ? `: ${preview(wt.paths, 6, wt.count)}` : '';
      parts.push(`${wt.count} uncommitted${listed}`);
    }
  } else if (Array.isArray(git.editedAfterLastCommit)) {
    const after = git.editedAfterLastCommit;
    parts.push(after.length ? `edited after last commit: ${preview(after, 6)}` : 'no edits after last commit');
  }
  return parts.join(' · ');
}

/**
 * @param {object} input hook stdin payload
 * @param {{db?: MemoryDb}} [opts]
 * @returns {string|null} markdown context, or null when there is nothing to inject
 */
export function buildRecall(input, { db = null } = {}) {
  if (!enabled) return null;
  const cwd = input.cwd || process.cwd();
  const project = resolveProject(cwd);
  if (isDisabledForProject(project.root)) return null;
  if (db === null && !existsSync(dbPath)) return null; // first run: nothing stored yet

  const own = db === null;
  // Claude waits for this hook: no one-off upkeep here (Stop and the CLI do it).
  const store = db ?? new MemoryDb(undefined, { maintenance: false });
  try {
    const total = store.countSessions(project.id);
    if (!total) return null;
    // Look further back than the recap shows, so that short sessions without
    // changes ("where did we stop?") do not take the places of real work.
    const candidates = store.recentSessions({ projectId: project.id, limit: recallSessions * 4, excludeId: input.session_id ?? null });
    if (!candidates.length) return null;
    const { sessions, skipped } = pickSessions(candidates, recallSessions);

    const header = [
      `# claude-mem-lite: previous sessions in this project (${project.name})`,
      `${total} session${total === 1 ? '' : 's'} stored locally. Newest first; a segment is the work up to one commit. The \`mem-search\` skill (/claude-mem-lite:mem-search) answers "when did we last touch <file>", shows one session or commit in full, and searches older work.`,
      '',
    ].join('\n');

    // Only the newest session can say where things were left, so only it is
    // compared with the current HEAD.
    const currentHead = readHead(findGitRoot(cwd));
    const notes = store.notesFor(commitShas(sessions[0]));
    let out = header;
    for (const [i, s] of sessions.entries()) {
      const brief = formatSessionBrief(s, { currentHead: i === 0 ? currentHead : null, newest: i === 0, notes }) + '\n\n';
      if (out.length + brief.length > recallMaxChars) {
        // Always show at least one session, even if it has to be cut.
        if (out === header) out += safeSlice(brief, recallMaxChars - out.length - 2) + '…\n';
        break;
      }
      out += brief;
    }
    if (skipped.length) {
      const latest = skipped[0];
      const asked = safeJson(latest.details).prompts?.[0]?.text;
      const line = `(${skipped.length} short session${skipped.length === 1 ? '' : 's'} without changes not shown; latest ${fmtTime(latest.started_at ?? latest.updated_at)}${asked ? `: "${truncate(asked, 80)}"` : ''})`;
      if (out.length + line.length + 2 <= recallMaxChars) out = `${out.trimEnd()}\n\n${line}`;
    }
    return bmpSafe(out.trimEnd());
  } finally {
    if (own) store.close();
  }
}

/** Prompts at most this many, and nothing changed: a check-in, not work. */
const TRIVIAL_PROMPTS = 3;

/**
 * A session that changed nothing in the project and was short: no edits to
 * project files, no commits, nothing undone or revisited, at most three
 * prompts ("where did we stop?", "claude plugin list"). Longer talks without
 * edits are kept: a design discussion may be where something was agreed.
 */
export function isTrivialSession(s) {
  const d = safeJson(s.details);
  const edited = (d.filesEdited ?? []).some((p) => isProjectPath(p));
  const committed = (d.segments ?? []).some((g) => g.commit) || (d.commits ?? []).length > 0;
  const prompts = d.stats?.prompts ?? d.prompts?.length ?? 0;
  return !edited && !committed && !(d.rework ?? []).length && prompts <= TRIVIAL_PROMPTS;
}

/**
 * The sessions to show: the newest `limit` that are not trivial, plus the
 * trivial ones that were passed over among them (newest first). When every
 * candidate is trivial, show them anyway rather than nothing.
 */
export function pickSessions(candidates, limit) {
  const sessions = [];
  const skipped = [];
  for (const s of candidates) {
    if (sessions.length >= limit) break;
    if (isTrivialSession(s)) skipped.push(s);
    else sessions.push(s);
  }
  if (!sessions.length) return { sessions: candidates.slice(0, limit), skipped: [] };
  return { sessions, skipped };
}

function commitShas(s) {
  return (safeJson(s.details).segments ?? []).filter((g) => g.commit).map((g) => g.commit.sha);
}

/** "a, b, c (+4 more)". `total` when `items` is itself already a capped list. */
function preview(items, max, total = items.length) {
  const shown = items.slice(0, max);
  return total > shown.length ? `${shown.join(', ')} (+${total - shown.length} more)` : shown.join(', ');
}

function safeJson(s) {
  try {
    return typeof s === 'string' ? JSON.parse(s) : s ?? {};
  } catch {
    return {};
  }
}
