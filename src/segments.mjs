// Splits a session into segments separated by its commits, and flags files
// whose work did not settle (undone or revisited). A commit is the natural unit of work:
// "when did we do X" is answered by a commit and the files and prompts around
// it, not by a stretch of wall-clock time.
//
// Segment k holds everything that happened up to and including commit k (after
// commit k-1). What happened after the last commit is an open segment with no
// commit - the uncommitted tail, or the whole session when nothing was
// committed.

import { posix, resolve } from 'node:path';
import { nativePath, walkCommand } from './shell.mjs';

/**
 * @typedef {object} Segment
 * @property {number} seq          position in the session (commit index; the open segment comes last)
 * @property {string|null} startedAt
 * @property {string|null} endedAt
 * @property {number} activeMin   minutes of actual activity: idle gaps over 10 minutes (a break,
 *                                 the night) are left out, so this answers "how long did it take"
 * @property {{sha:string, subject:string}|null} commit  null for the open segment
 * @property {{path:string, kind:string, ops:number}[]} files  files edited in the segment
 * @property {string[]} prompts    the user's prompts in the segment (already sanitised)
 */

/**
 * @typedef {object} Rework
 * @property {string} path
 * @property {'deleted'|'discarded'|'revisited'} reason
 * @property {number[]} segments   seqs where the file was edited
 * @property {number} edits
 */

/**
 * @param {object} input
 * @param {{path:string, kind:string, ms:number, project:boolean, doc:boolean}[]} input.edits  in call order
 * @param {{text:string, ms:number}[]} input.prompts
 * @param {{sha:string, subject:string, ms:number}[]} input.commits  sorted by time
 * @param {{targets:string[], reason:'deleted'|'discarded', ms:number}[]} input.removals
 *        from removalsFromCommand(); a target is a file, a directory, or '*' (everything uncommitted)
 * @param {[number, number][]} [input.activity]  [call, result] times (ms) of every tool call, for active time
 * @param {string|null} input.startedAt
 * @param {string|null} input.endedAt
 * @param {{maxPrompts?:number, maxFiles?:number}} [caps]
 * @returns {{segments: Segment[], rework: Rework[]}}
 */
export function buildSegments({ edits, prompts, commits, removals = [], activity = [], startedAt, endedAt }, { maxPrompts = 10, maxFiles = 60 } = {}) {
  const segOf = (ms) => {
    if (!Number.isFinite(ms)) return commits.length;
    const i = commits.findIndex((c) => ms <= c.ms);
    return i === -1 ? commits.length : i;
  };

  const n = commits.length + 1; // the last one is the open segment
  const segFiles = Array.from({ length: n }, () => new Map());
  const segPrompts = Array.from({ length: n }, () => []);
  const segFirst = Array.from({ length: n }, () => Infinity);
  const segLast = Array.from({ length: n }, () => -Infinity);
  const touch = (s, ms) => {
    if (!Number.isFinite(ms)) return;
    segFirst[s] = Math.min(segFirst[s], ms);
    segLast[s] = Math.max(segLast[s], ms);
  };

  /** path -> {segments:Set, edits, created, doc} for rework detection (project files only) */
  const history = new Map();
  for (const e of edits) {
    const s = segOf(e.ms);
    touch(s, e.ms);
    const cur = segFiles[s].get(e.path) ?? { path: e.path, kind: e.kind, ops: 0 };
    cur.ops++;
    if (e.kind !== 'edit') cur.kind = e.kind;
    segFiles[s].set(e.path, cur);
    if (!e.project) continue;
    const h = history.get(e.path) ?? { segments: new Set(), edits: 0, created: e.kind === 'write', doc: e.doc };
    h.segments.add(s);
    h.edits++;
    history.set(e.path, h);
  }
  /** Busy intervals [from, to] per segment: prompts are instants, tool calls last until their result. */
  const segBusy = Array.from({ length: n }, () => []);
  for (const p of prompts) {
    const s = segOf(p.ms);
    touch(s, p.ms);
    segPrompts[s].push(p.text);
    segBusy[s].push([p.ms, p.ms]);
  }
  for (const [from, to] of activity) if (Number.isFinite(from)) segBusy[segOf(from)].push([from, Number.isFinite(to) ? to : from]);

  const segments = [];
  let prevEnd = Date.parse(startedAt ?? '');
  for (let s = 0; s < n; s++) {
    const commit = commits[s] ?? null;
    if (commit === null) {
      // The open segment exists only when there is uncommitted work, or when
      // nothing was committed at all (then it is the whole session).
      if (commits.length && segFiles[s].size === 0) continue;
      if (!commits.length && segFiles[s].size === 0 && segPrompts[s].length === 0) continue;
    }
    const from = Number.isFinite(prevEnd) ? prevEnd : segFirst[s];
    const to = commit ? commit.ms : Math.max(segLast[s], Date.parse(endedAt ?? '') || -Infinity);
    segments.push({
      seq: s,
      startedAt: Number.isFinite(from) ? new Date(from).toISOString() : null,
      endedAt: Number.isFinite(to) ? new Date(to).toISOString() : null,
      activeMin: activeMinutes([...segBusy[s], ...(commit ? [[commit.ms, commit.ms]] : [])]),
      commit: commit ? { sha: commit.sha, subject: commit.subject } : null,
      files: [...segFiles[s].values()].slice(0, maxFiles),
      prompts: segPrompts[s].slice(-maxPrompts),
    });
    if (commit) prevEnd = commit.ms;
  }

  // Resolve removal targets to the files edited before the removal ran.
  const resolved = removals.map((r) => {
    const before = edits.filter((e) => e.project && e.ms < r.ms);
    const paths = new Set();
    for (const t of r.targets) {
      if (t === '*') {
        // git reset --hard: whatever was edited since the last commit.
        for (const e of before) if (segOf(e.ms) === segOf(r.ms)) paths.add(e.path);
        continue;
      }
      const target = posix.normalize(t).replace(/\/+$/, '');
      for (const e of before) if (e.path === target || e.path.startsWith(target + '/')) paths.add(e.path);
    }
    return { paths: [...paths], reason: r.reason };
  });

  // Segments that changed code (not just docs): only these mean "moved on to
  // something else". A docs-only commit between two code commits is not a gap.
  const codeSegs = new Set();
  for (const e of edits) if (e.project && !e.doc) codeSegs.add(segOf(e.ms));

  return { segments, rework: detectRework(history, resolved, codeSegs) };
}

/** A pause longer than this is a break, not work. */
const IDLE_MS = 10 * 60 * 1000;

/**
 * Minutes of activity: the union of busy intervals (a long-running command or
 * a subagent counts for its whole duration), plus the gaps between them that
 * are short enough to be thinking or reading rather than a break.
 * @param {[number, number][]} intervals
 */
export function activeMinutes(intervals) {
  const spans = intervals.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b)).sort((x, y) => x[0] - y[0]);
  let ms = 0;
  let end = null;
  for (const [a, b] of spans) {
    if (end === null) {
      ms += b - a;
      end = b;
    } else if (a <= end) {
      if (b > end) {
        ms += b - end;
        end = b;
      }
    } else {
      if (a - end <= IDLE_MS) ms += a - end;
      ms += b - a;
      end = b;
    }
  }
  return Math.round(ms / 60000);
}

/**
 * Files whose work did not settle. Signals, strongest first:
 *   deleted   - created in the session and removed again
 *   discarded - edits thrown away with git restore / checkout -- / reset --hard
 *   revisited - came back to after moving on: there is a gap of at least one
 *               segment between two edits, and either 3+ segments or 5+ edits.
 *               Docs are excluded (they are meant to be updated at every
 *               stage); a file edited in consecutive segments is ordinary
 *               progress, however central it is.
 * @returns {Rework[]}
 */
export function detectRework(history, removals, codeSegs = null) {
  const out = new Map();
  for (const r of removals) {
    for (const path of r.paths) {
      const h = history.get(path);
      if (!h || out.has(path) || isScratch(path)) continue;
      if (r.reason === 'deleted' && !h.created) continue;
      out.set(path, { path, reason: r.reason, segments: [...h.segments].sort((a, b) => a - b), edits: h.edits });
    }
  }
  // Position of each segment among the code-changing ones (all of them if unknown).
  const order = codeSegs ? [...codeSegs].sort((a, b) => a - b) : null;
  const rank = (s) => (order ? order.indexOf(s) : s);
  for (const [path, h] of history) {
    if (out.has(path) || h.doc) continue;
    const segs = [...h.segments].sort((a, b) => a - b);
    const gap = segs.some((s, i) => i > 0 && rank(s) - rank(segs[i - 1]) >= 2);
    if (gap && (segs.length >= 3 || h.edits >= 5)) {
      out.set(path, { path, reason: 'revisited', segments: segs, edits: h.edits });
    }
  }
  const weight = { deleted: 0, discarded: 1, revisited: 2 };
  return [...out.values()].sort((a, b) => weight[a.reason] - weight[b.reason] || b.edits - a.edits);
}

/** Throwaway files: creating and deleting them is housekeeping, not rework. */
function isScratch(path) {
  return /(^|\/)(\.?te?mp[-_.]|\.?te?mp\/|scratch)/i.test(path) || /\.(tmp|bak|log)$/i.test(path);
}

const REMOVE_CMD = /^(?:rm|git rm|del|erase|rmdir|Remove-Item|unlink)(?:\s|$)/i;
const DISCARD_CMD = /^git (?:restore|checkout --|reset --hard)(?:\s|$)/i;

/**
 * What a Bash command removes, or whose edits it throws away, as display
 * paths. Follows `cd <dir> && ...` chains so relative arguments resolve
 * against the right directory. A target may be a directory, or '*' for
 * `git reset --hard` (everything uncommitted).
 * @param {string} command
 * @param {string} cwd       the session's working directory
 * @param {(abs:string) => string} toDisplay  absolute path -> display path
 * @returns {{targets:string[], reason:'deleted'|'discarded'}[]}
 */
export function removalsFromCommand(command, cwd, toDisplay) {
  const out = [];
  walkCommand(command, cwd, (words, dir) => {
    const joined = words.join(' ');
    const reason = DISCARD_CMD.test(joined) ? 'discarded' : REMOVE_CMD.test(joined) ? 'deleted' : null;
    if (!reason) return;
    // `git restore --staged` only unstages; the edits survive.
    if (reason === 'discarded' && words.includes('--staged') && !words.includes('--worktree')) return;
    if (/^git$/i.test(words[0]) && /^reset$/i.test(words[1] ?? '')) {
      out.push({ targets: ['*'], reason });
      return;
    }
    const skip = /^git$/i.test(words[0]) ? 2 : 1;
    const targets = words.slice(skip).filter((w) => w !== '--' && !w.startsWith('-'));
    if (targets.length) out.push({ targets: targets.map((t) => toDisplay(resolve(dir, nativePath(t)))), reason });
  });
  return out;
}
