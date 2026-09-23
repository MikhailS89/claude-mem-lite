// Shared body of the Stop and SessionEnd hooks: read the transcript, compress
// it, and upsert the session row. Idempotent, so running it after every turn
// and once more at the end is safe.

import { existsSync } from 'node:fs';
import { enabled, isDisabledForProject } from './config.mjs';
import { MemoryDb } from './db.mjs';
import { logDebug } from './log.mjs';
import { findGitRoot, readHead, resolveProject } from './project.mjs';
import { summarize } from './summarize.mjs';
import { parseTranscriptFile } from './transcript.mjs';

/**
 * @param {object} input   hook stdin payload
 * @param {{final?: boolean, db?: MemoryDb}} [opts]
 * @returns {{skipped: string}|{sessionId: string, projectId: string, summary: string}}
 */
export function captureSession(input, { final = false, db = null } = {}) {
  if (!enabled) return { skipped: 'disabled by CLAUDE_MEM_LITE_ENABLED' };
  const sessionId = input.session_id;
  const transcriptPath = input.transcript_path;
  if (!sessionId || !transcriptPath) return { skipped: 'no session_id/transcript_path in hook input' };
  if (!existsSync(transcriptPath)) return { skipped: 'transcript file not found' };

  const cwd = input.cwd || process.cwd();
  const project = resolveProject(cwd);
  if (isDisabledForProject(project.root)) return { skipped: 'disabled for project' };

  const transcript = parseTranscriptFile(transcriptPath);
  // Nothing worth remembering yet (e.g. session opened and closed immediately).
  if (transcript.prompts.length === 0 && transcript.toolUses.length === 0) return { skipped: 'empty transcript' };

  // Stop runs after every turn, so the last capture holds HEAD at session end.
  const head = readHead(findGitRoot(cwd));
  const { title, summary, details, files, stats } = summarize(transcript, project, { head });

  const own = db === null;
  const store = db ?? new MemoryDb();
  try {
    store.upsertProject(project);
    store.upsertSession(
      {
        id: sessionId,
        projectId: project.id,
        title,
        branch: transcript.branch,
        cwd,
        startedAt: transcript.startedAt,
        endedAt: transcript.endedAt,
        status: final ? 'ended' : 'active',
        endReason: final ? input.reason ?? 'other' : null,
        summary,
        details,
        prompts: stats.prompts,
        toolCalls: stats.toolCalls,
      },
      files,
    );
  } finally {
    if (own) store.close();
  }
  logDebug('captured session', { sessionId, projectId: project.id, final, stats });
  return { sessionId, projectId: project.id, summary };
}
