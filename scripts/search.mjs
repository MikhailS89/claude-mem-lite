#!/usr/bin/env node
// CLI over the local memory database. Used directly from a terminal and by the
// `mem-search` skill. The unit of most answers is a segment: the work up to one
// commit (or the uncommitted tail of a session).
//
//   search.mjs touched <path-fragment>  when did we last touch a file, and what came of it
//   search.mjs <query...>               full-text search (current project by default)
//   search.mjs recent                   most recent segments (--sessions: sessions)
//   search.mjs show <session-id|sha>    one session in full, or the segment of one commit
//   search.mjs projects                 known projects
//   search.mjs forget <session-id>      delete one session
//   search.mjs forget-project <id>      delete a project and all its sessions
//   search.mjs where                    database location and current project id
//   search.mjs reindex                  rebuild rows written by older versions from their transcripts
//   search.mjs summarize [session-id]   write "what / why" notes for commits that have none (uses claude -p)
//   search.mjs replay <file.jsonl>      dry run: what the hooks would store and recall for a
//                                       transcript, without touching the database
//
// Flags: --all (every project)  --project <id>  --limit <n>  --since <7d|24h|2w|YYYY-MM-DD>
//        --json  --cwd <dir>  --sessions (recent)  --live (replay)

import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { buildSessionRecord } from '../src/capture.mjs';
import { dbPath, enabled } from '../src/config.mjs';
import { MemoryDb } from '../src/db.mjs';
import { bmpSafe } from '../src/privacy.mjs';
import { findGitRoot, readHead, resolveProject } from '../src/project.mjs';
import { pendingCommits, summarizePending } from '../src/notes.mjs';
import { fmtTime, formatSessionBrief, isLikelyOpen, parseSince, reworkLines, segmentLine, statedWhy } from '../src/recall.mjs';
import { findTranscript, reindexSome } from '../src/reindex.mjs';
import { parseTranscriptFile } from '../src/transcript.mjs';

function parseArgs(argv) {
  const opts = { all: false, project: null, limit: 10, json: false, live: false, sessions: false, since: null, cwd: process.cwd(), positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') opts.all = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--live') opts.live = true;
    else if (a === '--sessions') opts.sessions = true;
    else if (a === '--project') opts.project = argv[++i];
    else if (a === '--limit') opts.limit = Math.max(1, Number.parseInt(argv[++i], 10) || 10);
    else if (a === '--since') opts.since = parseSince(argv[++i]);
    else if (a === '--cwd') (opts.cwd = argv[++i]), (opts.cwdGiven = true);
    else if (a === '--help' || a === '-h') opts.help = true;
    else opts.positional.push(a);
  }
  return opts;
}

function usage() {
  return `claude-mem-lite search

  search.mjs touched <path-fragment>  when did we last touch a file, and what came of it
  search.mjs <query...>               full-text search (current project by default)
  search.mjs recent                   most recent segments; --sessions for whole sessions
  search.mjs show <session-id|sha>    a session in full, or the segment of one commit
  search.mjs projects                 known projects
  search.mjs forget <session-id>      delete one session
  search.mjs forget-project <id>      delete a project and all its sessions
  search.mjs where                    database location and current project id
  search.mjs reindex                  rebuild rows written by older versions from their transcripts
  search.mjs summarize [session-id]   write "what / why" notes for commits without one (claude -p, ~$0.01-0.015 each)
  search.mjs replay <file.jsonl>      dry run of capture + recap on a transcript (no db writes)

A segment is the work up to one commit, or the uncommitted tail of a session.

Flags: --all  --project <id>  --limit <n>  --since <24h|7d|2w|YYYY-MM-DD>  --json  --cwd <dir>
Database: ${dbPath}`;
}

// --- segment listings ----------------------------------------------------------

/** Two lines per segment: when + what, then where it lives; the commit note's "why" if there is one. */
function segmentEntry(g, extra = []) {
  const when = fmtTime(g.ended_at ?? g.started_at);
  const seg = { seq: g.seq, commit: g.commit_sha ? { sha: g.commit_sha, subject: g.commit_subject } : null, files: g.files, activeMin: g.active_min };
  const lines = [`${when}  ${segmentLine(seg, { listFiles: !seg.commit })}`];
  lines.push(`    session ${g.session_id.slice(0, 8)}${g.branch ? ` (${g.branch})` : ''}${g.title ? ` · ${g.title}` : ''}`);
  const why = statedWhy({ why: g.note_why });
  if (why) lines.push(`    why: ${why}`);
  return [...lines, ...extra.map((l) => `    ${l}`)].join('\n');
}

function printSegments(rows, json, extra = () => []) {
  if (json) return JSON.stringify(rows, null, 2);
  if (!rows.length) return 'No matching work.';
  return rows.map((g) => segmentEntry(g, extra(g))).join('\n\n');
}

/** Rework verdicts of one session, cached across rows. */
function reworkOf(db) {
  const cache = new Map();
  return (sessionId) => {
    if (!cache.has(sessionId)) cache.set(sessionId, parse(db.getSession(sessionId)?.details).rework ?? []);
    return cache.get(sessionId);
  };
}

function touched(db, fragment, { projectId, limit, since, json }) {
  const rows = db.touched(fragment, { projectId, limit, since });
  const rework = reworkOf(db);
  return printSegments(rows, json, (g) => {
    const flags = new Map(rework(g.session_id).map((r) => [r.path, r]));
    return g.matched.map((f) => {
      const r = flags.get(f.path);
      const note = r ? ` · ${r.reason === 'revisited' ? `revisited after moving on (${r.edits} edits in ${r.segments.length} segments)` : r.reason === 'deleted' ? 'created, then deleted' : 'edits discarded'}` : '';
      return `${f.kind} ×${f.ops}: ${f.path}${note}`;
    });
  });
}

function search(db, query, { projectId, limit, since, json }) {
  const segs = db.searchSegments(query, { projectId, limit, since });
  // Rows written before segments existed are only in the session index.
  const legacy = db
    .search(query, { projectId, limit, since })
    .filter((s) => !Array.isArray(parse(s.details).segments))
    .slice(0, Math.max(0, limit - segs.length));
  if (json) return JSON.stringify({ segments: segs, legacySessions: legacy.map(publicRow) }, null, 2);
  const parts = [];
  if (segs.length) parts.push(printSegments(segs, false, (g) => (g.prompts.length ? [`asked: ${g.prompts[g.prompts.length - 1].slice(0, 160)}`] : [])));
  if (legacy.length) parts.push(`Older sessions (recorded before segments):\n\n${legacy.map(sessionLine).join('\n\n')}`);
  return parts.join('\n\n') || 'No matching work.';
}

// --- sessions -------------------------------------------------------------------

function sessionLine(s) {
  const when = fmtTime(s.started_at ?? s.updated_at);
  const flag = isLikelyOpen(s) ? ' [possibly still open]' : '';
  return `${s.id.slice(0, 8)}  ${when}${s.branch ? '  ' + s.branch : ''}${flag}\n    ${s.summary}`;
}

function printSessions(rows, json) {
  if (json) return JSON.stringify(rows.map(publicRow), null, 2);
  if (!rows.length) return 'No matching sessions.';
  return rows.map(sessionLine).join('\n\n');
}

function publicRow(s) {
  return {
    id: s.id,
    project_id: s.project_id,
    title: s.title,
    branch: s.branch,
    started_at: s.started_at,
    ended_at: s.ended_at,
    status: s.status,
    prompts: s.prompts,
    tool_calls: s.tool_calls,
    summary: s.summary,
  };
}

/** `show <session-id>` or `show <commit sha>`. */
function show(db, id, json) {
  const s = db.getSession(id);
  if (s) return showSession(db, s, json);
  const g = db.segmentByCommit(id);
  if (!g) return `No session or commit found for: ${id}`;
  if (json) return JSON.stringify(g, null, 2);
  const session = db.getSession(g.session_id);
  return [segmentBlock(g), '', `Part of session ${g.session_id} (${fmtTime(session?.started_at)}${session?.title ? ` · ${session.title}` : ''}); \`show ${g.session_id.slice(0, 8)}\` for the rest.`].join('\n');
}

/** Full view of one segment: when, how long, commit, what was asked, files. */
function segmentBlock(g) {
  const head = g.commit_sha ? `${g.commit_sha.slice(0, 7)} ${g.commit_subject}` : g.seq > 0 ? 'uncommitted' : 'no commits recorded';
  const out = [`${head}`, `  ${fmtTime(g.started_at)} → ${fmtTime(g.ended_at)}${g.active_min ? `, ${g.active_min} min active` : ''}`];
  if (g.note_what) out.push(`  ${g.note_type ?? 'note'}: ${g.note_what}`);
  const why = statedWhy({ why: g.note_why });
  if (why) out.push(`  why: ${why}`);
  for (const p of g.prompts ?? []) out.push(`  asked: ${p}`);
  if (g.files?.length) out.push(`  files: ${g.files.map((f) => `${f.path}${f.ops > 1 ? ` ×${f.ops}` : ''}`).join(', ')}`);
  return out.join('\n');
}

function showSession(db, s, json) {
  const details = parse(s.details);
  const segments = db.sessionSegments(s.id);
  if (json) return JSON.stringify({ ...publicRow(s), cwd: s.cwd, details, segments }, null, 2);
  const out = [
    `Session ${s.id}`,
    `Project:  ${s.project_id}`,
    `When:     ${fmtTime(s.started_at)} → ${fmtTime(s.ended_at)}  (${s.status}${s.end_reason ? ', ' + s.end_reason : ''})`,
    `Branch:   ${s.branch ?? '-'}`,
    `Title:    ${s.title || '-'}`,
  ];
  const git = details.git;
  if (git?.head?.sha) out.push(`HEAD at end: ${git.head.sha.slice(0, 7)}${git.head.ref ? ` (${git.head.ref})` : ''}`);
  if (git?.worktree) {
    const wt = git.worktree;
    out.push(`Worktree:    ${wt.clean ? 'clean' : `${wt.count} uncommitted${wt.paths.length ? `: ${wt.paths.join(', ')}` : ''}${wt.hidden ? ` (+${wt.hidden} sensitive)` : ''}`}`);
  } else if (Array.isArray(git?.editedAfterLastCommit)) {
    out.push(`Edited after last commit: ${git.editedAfterLastCommit.length ? git.editedAfterLastCommit.join(', ') : 'none'}`);
  }
  out.push('');

  if (segments.length) {
    out.push(`Work (${segments.length} segment${segments.length === 1 ? '' : 's'}, oldest first):`, '');
    for (const g of segments) out.push(segmentBlock(g), '');
    const rework = reworkLines(details.rework ?? []);
    if (rework.length) out.push(...rework, '');
  } else {
    // Legacy row: no segments, show what was recorded.
    out.push(`Summary:  ${s.summary}`, '');
    if (details.prompts?.length) out.push('Prompts:', ...details.prompts.map((p) => `  - [${fmtTime(p.ts)}] ${p.text}`), '');
    if (details.commits?.length) out.push('Commits:', ...details.commits.map((c) => `  ${c.sha.slice(0, 7)} ${c.subject}`), '');
    const files = db.getSessionFiles(s.id).filter((f) => f.kind !== 'read');
    if (files.length) out.push('Edited files:', ...files.map((f) => `  - ${f.path} (${f.kind} ×${f.ops})`), '');
    // Without segments, commands are the only record of what was done.
    if (details.commands?.length) out.push('Commands (last 15):', ...details.commands.slice(-15).map((c) => `  $ ${c}`), '');
  }
  if (details.outcome) out.push('Last answer:', `  ${details.outcome}`, '');
  return out.join('\n').trimEnd();
}

// --- summarize ------------------------------------------------------------------

/**
 * Write "what / why" notes for commits that have none, now, in the foreground:
 * for one session, or for the sessions in scope (--since, --limit). Works even
 * with CLAUDE_MEM_LITE_LLM_SUMMARY off - running it is the opt-in.
 */
function summarizeCommand(db, sessionArg, { projectId, since, limit }) {
  const sessions = sessionArg ? [db.getSession(sessionArg)].filter(Boolean) : db.recentSessions({ projectId, since, limit });
  if (!sessions.length) return sessionArg ? `Session not found: ${sessionArg}` : 'No sessions in scope.';
  const lines = [];
  let total = 0;
  for (const s of sessions) {
    const pending = pendingCommits(db, s.id).length;
    if (!pending) continue;
    const r = summarizePending(db, { sessionId: s.id, transcriptPath: findTranscript(s.id), budget: Infinity });
    total += r.done;
    lines.push(`${s.id.slice(0, 8)}  ${r.locked ? 'busy (a worker is on it)' : `${r.done} noted, ${r.skipped} without conversation, ${r.failed} failed`}`);
  }
  return lines.length ? [...lines, `${total} commit note(s) written.`].join('\n') : 'Every commit in scope already has a note.';
}

// --- replay ---------------------------------------------------------------------

/**
 * Run the capture pipeline on a transcript and show what would be stored and
 * recalled, plus the invariants every recap must hold. Writes nothing.
 */
function replay(transcriptPath, opts) {
  if (!existsSync(transcriptPath)) return `Transcript not found: ${transcriptPath}`;
  const parsed = parseTranscriptFile(transcriptPath);
  const cwd = opts.cwdGiven ? opts.cwd : parsed.cwd ?? opts.cwd;
  const sessionId = parsed.sessionId ?? basename(transcriptPath, '.jsonl');
  const started = performance.now();
  // A transcript is usually from the past: today's HEAD and `git status` would
  // misdescribe it. `--live` treats it as the session running now.
  const record = buildSessionRecord({ sessionId, transcriptPath, cwd, live: opts.live });
  const ms = Math.round(performance.now() - started);
  if (!record) return 'Empty transcript: nothing would be stored.';
  if (opts.json) return JSON.stringify(record, null, 2);

  const { row } = record;
  const brief = bmpSafe(
    formatSessionBrief(
      { id: row.id, started_at: row.startedAt, updated_at: row.endedAt, branch: row.branch, title: row.title, status: 'ended', details: JSON.stringify(row.details) },
      { currentHead: readHead(findGitRoot(cwd)) },
    ),
  );
  const checks = [
    ['recap is well-formed UTF-16', brief.isWellFormed()],
    ['recap has no astral characters', !/[\uD800-\uDFFF]/.test(brief)],
    ['stored row is well-formed UTF-16', JSON.stringify(row).isWellFormed()],
    ['every commit starts a segment', row.details.commits.every((c) => row.details.segments.some((g) => g.commit?.sha === c.sha))],
  ];
  return [
    `Transcript: ${transcriptPath}`,
    `Project:    ${record.project.id}  (cwd ${cwd})`,
    `Captured in ${ms} ms: ${record.stats.prompts} prompts, ${record.stats.toolCalls} tool calls, ${row.details.commits.length} commits, ${row.details.segments.length} segments`,
    '',
    'Recap entry:',
    brief,
    '',
    `Summary: ${row.summary}`,
    '',
    ...checks.map(([name, ok]) => `${ok ? 'ok  ' : 'FAIL'} ${name}`),
  ].join('\n');
}

// --- main -----------------------------------------------------------------------

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return usage();
  const [cmd, ...rest] = opts.positional;
  const project = resolveProject(opts.cwd);
  const projectId = opts.all ? null : opts.project ?? project.id;
  const scope = { projectId, limit: opts.limit, since: opts.since, json: opts.json };

  if (cmd === 'where' || (!cmd && !opts.positional.length && opts.json)) {
    return JSON.stringify({ dbPath, exists: existsSync(dbPath), enabled, project }, null, 2);
  }
  if (!cmd) return usage();
  if (cmd === 'replay') return rest[0] ? replay(rest[0], opts) : 'Usage: replay <transcript.jsonl> [--cwd <project dir>] [--live]';
  if (!existsSync(dbPath)) return `No memory database yet (${dbPath}). It is created after the first session with the plugin enabled.`;

  const db = new MemoryDb();
  try {
    switch (cmd) {
      case 'recent':
        return opts.sessions
          ? printSessions(db.recentSessions({ projectId, limit: opts.limit, since: opts.since }), opts.json)
          : printSegments(db.recentSegments({ projectId, limit: opts.limit, since: opts.since }), opts.json);
      case 'show':
        return rest[0] ? show(db, rest[0], opts.json) : 'Usage: show <session-id|commit sha>';
      case 'touched':
      case 'file':
        return rest[0] ? touched(db, rest[0], scope) : 'Usage: touched <path-fragment>';
      case 'projects': {
        const rows = db.listProjects();
        if (opts.json) return JSON.stringify(rows, null, 2);
        return rows.length
          ? rows.map((p) => `${p.id}\n    ${p.root_path}  (${p.sessions} sessions, last ${fmtTime(p.last_seen_at)})`).join('\n')
          : 'No projects stored.';
      }
      case 'forget':
        return rest[0] ? `Deleted ${db.deleteSession(db.getSession(rest[0])?.id ?? rest[0])} session(s).` : 'Usage: forget <session-id>';
      case 'forget-project':
        return rest[0] ? `Deleted ${db.deleteProject(rest[0])} project(s).` : 'Usage: forget-project <project-id>';
      case 'summarize':
        return summarizeCommand(db, rest[0], { projectId, since: opts.since, limit: opts.limit });
      case 'reindex': {
        const r = reindexSome(db, { budget: Infinity, force: true });
        return `Rebuilt ${r.rebuilt} session(s) from their transcripts; ${r.missing} kept as legacy records (transcript no longer on disk).`;
      }
      case 'search':
        return search(db, rest.join(' '), scope);
      default:
        // Bare words are a search query.
        return search(db, opts.positional.join(' '), scope);
    }
  } finally {
    db.close();
  }
}

function parse(details) {
  try {
    return typeof details === 'string' ? JSON.parse(details) : details ?? {};
  } catch {
    return {};
  }
}

try {
  process.stdout.write(main() + '\n');
} catch (err) {
  process.stderr.write(`claude-mem-lite: ${err.message}\n`);
  process.exitCode = 1;
}
