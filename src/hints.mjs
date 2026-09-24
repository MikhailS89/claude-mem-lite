// A file's history, shown to Claude the first time it reads or edits that
// file in a session (PostToolUse on Read / Edit / Write / NotebookEdit).
//
// Without it, Claude sees a file's current content and nothing about how it
// got there: that the last approach was replaced, that the file was reworked,
// why the last change was made. `git log` would tell some of it, but Claude
// rarely runs it on its own. The hint costs no tool call, appears once per
// file per session, and only when there is history from earlier sessions.

import { existsSync } from 'node:fs';
import { dbPath, enabled, fileHints, isDisabledForProject } from './config.mjs';
import { MemoryDb } from './db.mjs';
import { bmpSafe, isSensitivePath, truncate } from './privacy.mjs';
import { resolveProject } from './project.mjs';
import { fmtTime, statedWhy } from './recall.mjs';
import { displayPath, isProjectPath } from './summarize.mjs';

const TOOLS = { Read: 'file_path', Edit: 'file_path', MultiEdit: 'file_path', Write: 'file_path', NotebookEdit: 'notebook_path' };

/**
 * @param {object} input PostToolUse hook payload
 * @param {{db?: MemoryDb}} [opts]
 * @returns {string|null} the hint, or null when there is nothing worth saying
 */
export function fileHint(input, { db = null } = {}) {
  if (!enabled || !fileHints || input.agent_id) return null;
  const field = TOOLS[input.tool_name];
  const filePath = field ? input.tool_input?.[field] : null;
  if (typeof filePath !== 'string' || !filePath || isSensitivePath(filePath)) return null;
  const sessionId = input.session_id;
  if (!sessionId) return null;

  const project = resolveProject(input.cwd || process.cwd());
  if (isDisabledForProject(project.root)) return null;
  const path = displayPath(filePath, project.root);
  if (!isProjectPath(path)) return null;
  if (db === null && !existsSync(dbPath)) return null;

  const own = db === null;
  const store = db ?? new MemoryDb(undefined, { busyTimeoutMs: 200 });
  try {
    // Once per file per session, whether or not there is history to show.
    if (!store.claimFileHint(sessionId, path)) return null;
    const history = store.fileHistory(path, { projectId: project.id, excludeSessionId: sessionId });
    if (!history.rows.length) return null;
    return bmpSafe(formatHint(path, history));
  } finally {
    if (own) store.close();
  }
}

/** A few lines: the latest changes (commit, why), then anything that did not settle. */
export function formatHint(path, { rows, total, rework }) {
  const lines = [`claude-mem-lite: ${path} in earlier sessions (${total} change${total === 1 ? '' : 's'}):`];
  for (const g of rows) {
    const what = g.commit_sha ? `${g.commit_sha.slice(0, 7)} ${truncate(g.commit_subject ?? '', 90)}` : g.seq > 0 ? 'left uncommitted' : 'no commit recorded';
    const why = statedWhy({ why: g.note_why });
    lines.push(`- ${fmtTime(g.ended_at ?? g.started_at).slice(0, 10)} ${what}${why ? ` - why: ${truncate(why, 160)}` : ''}`);
  }
  for (const r of rework.slice(0, 2)) {
    const how = r.reason === 'deleted' ? 'created, then deleted' : r.reason === 'discarded' ? 'edits discarded' : `revisited after moving on (${r.edits} edits in ${r.segments.length} segments)`;
    lines.push(`- ${how} in session ${r.sessionId.slice(0, 8)}`);
  }
  if (total > rows.length) lines.push(`- more: mem-search \`touched ${path}\``);
  return lines.join('\n');
}
