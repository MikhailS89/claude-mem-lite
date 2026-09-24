// Shared body of the Stop and SessionEnd hooks: read the transcript, compress
// it, and upsert the session row. Idempotent, so running it after every turn
// and once more at the end is safe.

import { existsSync } from 'node:fs';
import { enabled, gitStatus, isDisabledForProject, limits } from './config.mjs';
import { MemoryDb } from './db.mjs';
import { logDebug } from './log.mjs';
import { findGitRoot, objectLookup, readCommits, readHead, resolveProject } from './project.mjs';
import { summarize } from './summarize.mjs';
import { readWorktree } from './worktree.mjs';
import { parseTranscriptFile } from './transcript.mjs';

/**
 * @param {object} input   hook stdin payload
 * @param {{final?: boolean, db?: MemoryDb}} [opts]
 * @returns {{skipped: string}|{sessionId: string, projectId: string, summary: string}}
 */
export function captureSession(input, { final = false, db = null } = {}) {
  if (!enabled) return { skipped: 'disabled by CLAUDE_MEM_LITE_ENABLED' };
  // Only the main conversation owns the session record. Claude Code turns Stop
  // into SubagentStop inside subagents, so this is a guard, not a hot path: a
  // subagent's transcript must never overwrite the session's row.
  if (input.agent_id) return { skipped: 'subagent hook' };
  const sessionId = input.session_id;
  const transcriptPath = input.transcript_path;
  if (!sessionId || !transcriptPath) return { skipped: 'no session_id/transcript_path in hook input' };
  if (!existsSync(transcriptPath)) return { skipped: 'transcript file not found' };

  const cwd = input.cwd || process.cwd();
  if (isDisabledForProject(resolveProject(cwd).root)) return { skipped: 'disabled for project' };

  // The row is written before `git status` runs: in `claude -p` Claude Code
  // stops this background hook as soon as it exits, and the session record
  // matters more than the worktree line, which follows in a second write.
  const base = { sessionId, transcriptPath, cwd, final, endReason: input.reason };
  const record = buildSessionRecord({ ...base, worktree: null });
  // Nothing worth remembering yet (e.g. session opened and closed immediately).
  if (!record) return { skipped: 'empty transcript' };

  const own = db === null;
  const store = db ?? new MemoryDb();
  let stored = record;
  try {
    store.upsertProject(record.project);
    store.upsertSession(record.row, record.files);
    logDebug('captured session', { sessionId, projectId: record.project.id, final, stats: record.stats });
    const worktree = gitStatus ? readWorktree(record.gitRoot) : null;
    if (worktree) {
      stored = buildSessionRecord({ ...base, worktree, transcript: record.transcript });
      store.upsertSession(stored.row, stored.files);
    }
  } finally {
    if (own) store.close();
  }
  return { sessionId, projectId: record.project.id, summary: stored.row.summary };
}

/**
 * Everything the database would store for one session, without storing it.
 * Shared by the hooks, by re-indexing and by `search.mjs replay`, so all of
 * them exercise exactly the code the hooks run.
 *
 * `live` means the session is happening now (the hooks): the repository's
 * current HEAD and `git status` describe its end state. For an old transcript
 * (re-indexing, replay) they describe today instead, so HEAD at end is taken
 * from the session's own last commit and the worktree is left unknown.
 *
 * `worktree`: 'auto' runs `git status` for a live session; null skips it; an
 * object is used as is. `transcript` reuses an already parsed transcript.
 * @returns {{project: object, row: object, files: object[], stats: object, gitRoot: string|null, transcript: object}|null}
 *          null for an empty transcript
 */
export function buildSessionRecord({ sessionId, transcriptPath, cwd, final = false, endReason = null, live = true, worktree: wt = 'auto', transcript: parsed = null }) {
  const project = resolveProject(cwd);
  const transcript = parsed ?? parseTranscriptFile(transcriptPath);
  if (transcript.prompts.length === 0 && transcript.toolUses.length === 0) return null;

  // Stop runs after every turn, so the last live capture holds HEAD at session end.
  const gitRoot = findGitRoot(cwd);
  const currentHead = readHead(gitRoot);
  const since = Date.parse(transcript.startedAt ?? '');
  // An old session may have hundreds of commits on top of it; walk further back.
  const max = live ? limits.commits : 500;
  const headCommits = currentHead?.sha && Number.isFinite(since) ? readCommits(gitRoot, currentHead.sha, { since, max }) : [];
  const commitExists = objectLookup(gitRoot);
  const worktree = wt === 'auto' ? (live && gitStatus ? readWorktree(gitRoot) : null) : live ? wt : null;
  const { title, summary, details, files, stats } = summarize(transcript, project, {
    head: live ? currentHead : null,
    headCommits,
    commitExists,
    worktree,
  });
  if (!live && details.commits.length) {
    const last = details.commits[details.commits.length - 1];
    details.git.head = { ref: last.branch ?? transcript.branch ?? null, sha: last.sha };
  }

  const row = {
    id: sessionId,
    projectId: project.id,
    title,
    branch: transcript.branch,
    cwd,
    startedAt: transcript.startedAt,
    endedAt: transcript.endedAt,
    status: final ? 'ended' : 'active',
    endReason: final ? endReason ?? 'other' : null,
    summary,
    details,
    prompts: stats.prompts,
    toolCalls: stats.toolCalls,
  };
  return { project, row, files, stats, gitRoot, transcript };
}
