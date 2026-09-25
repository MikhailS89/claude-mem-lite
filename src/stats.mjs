// `search.mjs stats`: is the memory used, and does a recap change how work starts?
//
// Sessions the plugin recorded carry `details.usage`; older rows and sessions
// it never saw (before it was installed, or while it was off) are read from
// their transcripts, which gives the "without recap" baseline.

import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { resolveProject } from './project.mjs';
import { findTranscript, listTranscripts, transcriptRoots } from './reindex.mjs';
import { displayPath } from './summarize.mjs';
import { parseTranscriptFile } from './transcript.mjs';
import { aggregateUsage, usageOf } from './usage.mjs';

/**
 * @param {import('./db.mjs').MemoryDb} db
 * @param {object} [opts]
 * @param {string|null} [opts.projectId]  null: every project
 * @param {string|null} [opts.since]      ISO time
 * @param {string[]} [opts.roots]         transcript roots
 * @param {string|null} [opts.scratch]    sessions under this directory are experiments, not work
 */
export function collectStats(db, { projectId = null, since = null, roots = transcriptRoots(), scratch = tmpdir() } = {}) {
  const projects = new Map(); // cwd -> project, resolved once
  const projectOf = (cwd) => {
    if (!projects.has(cwd)) projects.set(cwd, resolveProject(cwd));
    return projects.get(cwd);
  };
  const fromTranscript = (t) => usageOf(t, (p) => displayPath(p, projectOf(t.cwd ?? '.').root));
  const scratchDir = scratch ? resolve(scratch).toLowerCase() : null;
  const throwaway = (cwd) => !!(scratchDir && cwd && resolve(cwd).toLowerCase().startsWith(scratchDir));

  const usages = [];
  const known = new Set();
  let noData = 0;
  for (const s of db.recentSessions({ projectId, since, limit: 1e6 })) {
    known.add(s.id);
    if (throwaway(s.cwd)) continue;
    let u = parseDetails(s.details).usage;
    const path = u ? null : findTranscript(s.id, roots);
    if (path) {
      try {
        u = fromTranscript(parseTranscriptFile(path));
      } catch {}
    }
    if (u) usages.push(u);
    else noData++;
  }

  let unrecorded = 0;
  const sinceMs = since ? Date.parse(since) : null;
  for (const f of listTranscripts(roots)) {
    if (known.has(f.id) || (sinceMs && f.mtimeMs < sinceMs)) continue;
    let t;
    try {
      t = parseTranscriptFile(f.path);
    } catch {
      continue;
    }
    if (!t.cwd || throwaway(t.cwd) || !t.toolUses.length || (sinceMs && Date.parse(t.endedAt) < sinceMs)) continue;
    if (projectId && projectOf(t.cwd).id !== projectId) continue;
    usages.push(fromTranscript(t));
    unrecorded++;
  }

  return { ...aggregateUsage(usages), unrecorded, noData, commitNotes: db.noteTotals({ projectId, since }) };
}

function parseDetails(details) {
  try {
    return typeof details === 'string' ? JSON.parse(details) : details ?? {};
  } catch {
    return {};
  }
}
