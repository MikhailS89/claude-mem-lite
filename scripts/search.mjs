#!/usr/bin/env node
// CLI over the local memory database. Used directly from a terminal and by the
// `mem-search` skill.
//
//   search.mjs <query...>            full-text search (current project by default)
//   search.mjs recent                most recent sessions
//   search.mjs show <session-id>     full details of one session (id prefix is fine)
//   search.mjs file <path-fragment>  sessions that touched a matching file
//   search.mjs projects              known projects
//   search.mjs forget <session-id>   delete one session
//   search.mjs forget-project <id>   delete a project and all its sessions
//   search.mjs where                 print database location and current project id
//
// Flags: --all (every project)  --project <id>  --limit <n>  --json  --cwd <dir>

import { existsSync } from 'node:fs';
import { dbPath, enabled } from '../src/config.mjs';
import { MemoryDb } from '../src/db.mjs';
import { resolveProject } from '../src/project.mjs';
import { fmtTime, isLikelyOpen } from '../src/recall.mjs';

function parseArgs(argv) {
  const opts = { all: false, project: null, limit: 10, json: false, cwd: process.cwd(), positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') opts.all = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--project') opts.project = argv[++i];
    else if (a === '--limit') opts.limit = Math.max(1, Number.parseInt(argv[++i], 10) || 10);
    else if (a === '--cwd') opts.cwd = argv[++i];
    else if (a === '--help' || a === '-h') opts.help = true;
    else opts.positional.push(a);
  }
  return opts;
}

function usage() {
  return `claude-mem-lite search

  search.mjs <query...>            full-text search (current project by default)
  search.mjs recent                most recent sessions
  search.mjs show <session-id>     full details of one session (id prefix is fine)
  search.mjs file <path-fragment>  sessions that touched a matching file
  search.mjs projects              known projects
  search.mjs forget <session-id>   delete one session
  search.mjs forget-project <id>   delete a project and all its sessions
  search.mjs where                 database location and current project id

Flags: --all  --project <id>  --limit <n>  --json  --cwd <dir>
Database: ${dbPath}`;
}

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

function showSession(db, id, json) {
  const s = db.getSession(id);
  if (!s) return `Session not found: ${id}`;
  const details = JSON.parse(s.details);
  const files = db.getSessionFiles(s.id);
  if (json) return JSON.stringify({ ...publicRow(s), cwd: s.cwd, details, files }, null, 2);
  const out = [
    `Session ${s.id}`,
    `Project:  ${s.project_id}`,
    `When:     ${fmtTime(s.started_at)} → ${fmtTime(s.ended_at)}  (${s.status}${s.end_reason ? ', ' + s.end_reason : ''})`,
    `Branch:   ${s.branch ?? '-'}`,
    `Title:    ${s.title || '-'}`,
    `Summary:  ${s.summary}`,
    '',
  ];
  if (details.prompts?.length) {
    out.push('Prompts:');
    for (const p of details.prompts) out.push(`  - [${fmtTime(p.ts)}] ${p.text}`);
    out.push('');
  }
  const edited = files.filter((f) => f.kind !== 'read');
  const read = files.filter((f) => f.kind === 'read');
  if (edited.length) out.push('Edited files:', ...edited.map((f) => `  - ${f.path} (${f.kind} ×${f.ops})`), '');
  if (read.length) out.push('Read files:', ...read.map((f) => `  - ${f.path} (×${f.ops})`), '');
  if (details.commands?.length) out.push('Commands:', ...details.commands.map((c) => `  $ ${c}`), '');
  if (details.outcome) out.push('Outcome:', `  ${details.outcome}`, '');
  if (details.tools) out.push(`Tools: ${Object.entries(details.tools).map(([k, v]) => `${k}×${v}`).join(', ')}`);
  return out.join('\n');
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return usage();
  const [cmd, ...rest] = opts.positional;
  const project = resolveProject(opts.cwd);
  const projectId = opts.all ? null : opts.project ?? project.id;

  if (cmd === 'where' || (!cmd && !opts.positional.length && opts.json)) {
    return JSON.stringify({ dbPath, exists: existsSync(dbPath), enabled, project }, null, 2);
  }
  if (!cmd) return usage();
  if (!existsSync(dbPath)) return `No memory database yet (${dbPath}). It is created after the first session with the plugin enabled.`;

  const db = new MemoryDb();
  try {
    switch (cmd) {
      case 'recent':
        return printSessions(db.recentSessions({ projectId, limit: opts.limit }), opts.json);
      case 'show':
        return rest[0] ? showSession(db, rest[0], opts.json) : 'Usage: show <session-id>';
      case 'file':
        return rest[0] ? printSessions(db.searchByFile(rest[0], { projectId, limit: opts.limit }), opts.json) : 'Usage: file <path-fragment>';
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
      case 'search':
        return printSessions(db.search(rest.join(' '), { projectId, limit: opts.limit }), opts.json);
      default:
        // Bare words are a search query.
        return printSessions(db.search(opts.positional.join(' '), { projectId, limit: opts.limit }), opts.json);
    }
  } finally {
    db.close();
  }
}

try {
  process.stdout.write(main() + '\n');
} catch (err) {
  process.stderr.write(`claude-mem-lite: ${err.message}\n`);
  process.exitCode = 1;
}
