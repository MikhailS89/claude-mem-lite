// Builds the short recap injected on SessionStart. This is the "index level"
// of progressive disclosure: a handful of one-paragraph session summaries,
// hard-capped in size. Full details are only fetched on demand via the
// mem-search skill / CLI.

import { existsSync } from 'node:fs';
import { dbPath, enabled, isDisabledForProject, recallMaxChars, recallSessions } from './config.mjs';
import { MemoryDb } from './db.mjs';
import { bmpSafe, safeSlice, truncate } from './privacy.mjs';
import { findGitRoot, readHead, resolveProject } from './project.mjs';
import { briefText, commandHead, isDocPath } from './summarize.mjs';

/** Format an ISO timestamp as `YYYY-MM-DD HH:MM` in local time. */
export function fmtTime(iso) {
  if (!iso) return '?';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '?';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
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

/** Commits shown per session; older ones are counted, not listed. */
const RECAP_COMMITS = 8;

/**
 * One session -> a few lines of markdown. Leads with state (commits, HEAD,
 * uncommitted edits) rather than activity. Rows written by older versions
 * have no commits/git in `details` and fall back to the activity lines.
 * @param {object} s session row
 * @param {{currentHead?: {ref:string|null, sha:string|null}|null}} [opts]
 *        HEAD of the repository now, to tell whether it moved since
 */
export function formatSessionBrief(s, { currentHead = null } = {}) {
  const d = safeJson(s.details);
  const title = [`### ${fmtTime(s.started_at ?? s.updated_at)}`, s.branch ? `· ${s.branch}` : '', s.title ? `· ${s.title}` : '']
    .filter(Boolean)
    .join(' ');
  const lines = [title];
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

/** "HEAD at end: 542b65e (main) · edited after last commit: a.ts" */
function formatHead(git, currentHead) {
  if (!git) return '';
  const parts = [];
  const sha = git.head?.sha ?? null;
  if (sha) {
    let s = `HEAD at end: ${sha.slice(0, 7)}`;
    if (git.head.ref) s += ` (${git.head.ref})`;
    if (currentHead?.sha && currentHead.sha !== sha) {
      s += `, now ${currentHead.sha.slice(0, 7)}${currentHead.ref && currentHead.ref !== git.head.ref ? ` (${currentHead.ref})` : ''}`;
    }
    parts.push(s);
  }
  const after = git.editedAfterLastCommit;
  if (Array.isArray(after)) {
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
  const store = db ?? new MemoryDb();
  try {
    const total = store.countSessions(project.id);
    if (!total) return null;
    const sessions = store.recentSessions({ projectId: project.id, limit: recallSessions, excludeId: input.session_id ?? null });
    if (!sessions.length) return null;

    const header = [
      `# claude-mem-lite: previous sessions in this project (${project.name})`,
      `${total} session${total === 1 ? '' : 's'} stored locally. Newest first. For details or to search older work use the \`mem-search\` skill (/claude-mem-lite:mem-search <query>).`,
      '',
    ].join('\n');

    // Only the newest session can say where things were left, so only it is
    // compared with the current HEAD.
    const currentHead = readHead(findGitRoot(cwd));
    let out = header;
    for (const [i, s] of sessions.entries()) {
      const brief = formatSessionBrief(s, { currentHead: i === 0 ? currentHead : null }) + '\n\n';
      if (out.length + brief.length > recallMaxChars) {
        // Always show at least one session, even if it has to be cut.
        if (out === header) out += safeSlice(brief, recallMaxChars - out.length - 2) + '…\n';
        break;
      }
      out += brief;
    }
    return bmpSafe(out.trimEnd());
  } finally {
    if (own) store.close();
  }
}

function preview(items, max) {
  const shown = items.slice(0, max).join(', ');
  return items.length > max ? `${shown} (+${items.length - max} more)` : shown;
}

function safeJson(s) {
  try {
    return typeof s === 'string' ? JSON.parse(s) : s ?? {};
  } catch {
    return {};
  }
}
