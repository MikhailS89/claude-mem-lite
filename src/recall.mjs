// Builds the short recap injected on SessionStart. This is the "index level"
// of progressive disclosure: a handful of one-paragraph session summaries,
// hard-capped in size. Full details are only fetched on demand via the
// mem-search skill / CLI.

import { existsSync } from 'node:fs';
import { dbPath, enabled, isDisabledForProject, recallMaxChars, recallSessions } from './config.mjs';
import { MemoryDb } from './db.mjs';
import { truncate } from './privacy.mjs';
import { resolveProject } from './project.mjs';
import { commandHead } from './summarize.mjs';

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

/** One session -> a few lines of markdown. */
export function formatSessionBrief(s) {
  const d = safeJson(s.details);
  const head = [`### ${fmtTime(s.started_at ?? s.updated_at)}`, s.branch ? `· ${s.branch}` : '', s.title ? `· ${s.title}` : '']
    .filter(Boolean)
    .join(' ');
  const lines = [head];
  const edited = d.filesEdited ?? [];
  const read = d.filesRead ?? [];
  if (edited.length) lines.push(`- edited: ${preview(edited, 8)}`);
  if (read.length && !edited.length) lines.push(`- read: ${preview(read, 6)}`);
  const cmds = [...new Set((d.commands ?? []).map(commandHead).filter(Boolean))];
  if (cmds.length) lines.push(`- ran: ${preview(cmds, 8)}`);
  const prompts = d.prompts ?? [];
  if (prompts.length) lines.push(`- last request: ${truncate(prompts[prompts.length - 1].text, 200)}`);
  if (d.outcome) lines.push(`- outcome: ${truncate(d.outcome, 300)}`);
  lines.push(`- session: ${s.id.slice(0, 8)} (${s.prompts} prompts, ${s.tool_calls} tool calls${isLikelyOpen(s) ? ', possibly still open' : ''})`);
  return lines.join('\n');
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

    let out = header;
    for (const s of sessions) {
      const brief = formatSessionBrief(s) + '\n\n';
      if (out.length + brief.length > recallMaxChars) {
        // Always show at least one session, even if it has to be cut.
        if (out === header) out += brief.slice(0, recallMaxChars - out.length - 2) + '…\n';
        break;
      }
      out += brief;
    }
    return out.trimEnd();
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
