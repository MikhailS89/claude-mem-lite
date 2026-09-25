// Does the memory get used, and does it change how a session starts?
//
// Per session (read from its transcript, stored in `details.usage`):
//   recaps / recapChars   SessionStart recaps Claude actually received, and the first one's size
//   hints                 file-history hints shown after Read/Edit
//   memSearch             lookups through the mem-search CLI, by subcommand
//   callsBeforeEdit       tool calls before the first edit of a project file (the orientation phase);
//                         null when nothing was edited
//   historyBeforeEdit     `git log/show/blame/reflog` calls in that phase: the lookups a recap
//                         is meant to replace
//
// `aggregateUsage` compares sessions that started with a recap against those
// that did not, which is the measurable effect of the plugin.

import { isProjectPath } from './summarize.mjs';

/** Subcommands that look something up in memory; the rest (replay, reindex, ...) are maintenance. */
const LOOKUPS = new Set(['touched', 'file', 'recent', 'show', 'search']);
const MAINTENANCE = new Set(['where', 'projects', 'forget', 'forget-project', 'reindex', 'summarize', 'replay', 'stats']);

/** Flags of search.mjs that take a value. */
const VALUE_FLAGS = new Set(['--project', '--limit', '--since', '--cwd']);

const GIT_HISTORY = /\bgit\b(?:\s+-C\s+("[^"]*"|'[^']*'|\S+))?\s+(log|show|blame|reflog)\b/;

/**
 * The memory lookup a Bash command made through search.mjs, or null.
 * A bare query (`search.mjs login bug`) is a search.
 *
 * The skill runs the script by an absolute path (`${CLAUDE_PLUGIN_ROOT}/scripts/search.mjs`).
 * A relative `scripts/search.mjs` is work on the plugin itself, and a command
 * that points CLAUDE_MEM_LITE_DIR elsewhere queries a test database: neither
 * is Claude using its memory.
 */
export function memLookup(command) {
  const cmd = String(command ?? '');
  if (/\bCLAUDE_MEM_LITE_DIR=/.test(cmd)) return null;
  const m = /(?:\$\{?CLAUDE_PLUGIN_ROOT\}?|(?<![\w.])(?:[A-Za-z]:[\\/]|\/|~\/))[^\s"']*search\.mjs["']?((?:\s+("[^"]*"|'[^']*'|[^\s|;&]+))*)/.exec(cmd);
  if (!m) return null;
  const args = m[1].trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (VALUE_FLAGS.has(a)) i++;
    else if (a.startsWith('-')) continue;
    else return LOOKUPS.has(a) ? a : MAINTENANCE.has(a) ? null : 'search';
  }
  return null; // usage text only
}

/**
 * @param {import('./transcript.mjs').ParsedTranscript} t
 * @param {(path: string) => string} display  file path as stored (project-relative)
 */
export function usageOf(t, display = (p) => p) {
  const recaps = t.injections.filter((i) => i.event === 'SessionStart');
  const memSearch = {};
  let callsBeforeEdit = null;
  let historyBeforeEdit = 0;
  for (const [i, u] of t.toolUses.entries()) {
    const cmd = u.name === 'Bash' ? String(u.input?.command ?? '') : '';
    const lookup = cmd ? memLookup(cmd) : null;
    if (lookup) memSearch[lookup] = (memSearch[lookup] ?? 0) + 1;
    if (callsBeforeEdit !== null) continue;
    const path = u.input?.file_path ?? u.input?.notebook_path;
    const edits = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(u.name);
    if (edits && !u.isError && typeof path === 'string' && isProjectPath(display(path))) {
      callsBeforeEdit = i;
      continue;
    }
    if (cmd && GIT_HISTORY.test(cmd)) historyBeforeEdit++;
  }
  return {
    recaps: recaps.length,
    recapChars: recaps[0]?.chars ?? 0,
    hints: t.injections.filter((i) => i.event === 'PostToolUse').length,
    memSearch,
    callsBeforeEdit,
    historyBeforeEdit: callsBeforeEdit === null ? null : historyBeforeEdit,
  };
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

/** Orientation figures for a group of sessions: only sessions that edited something have one. */
function orientation(list) {
  const edited = list.filter((u) => u.callsBeforeEdit !== null);
  return {
    sessions: list.length,
    edited: edited.length,
    medianCallsBeforeEdit: median(edited.map((u) => u.callsBeforeEdit)),
    historyLookupsPerSession: mean(edited.map((u) => u.historyBeforeEdit)),
    sessionsWithHistoryLookups: edited.filter((u) => u.historyBeforeEdit > 0).length,
  };
}

/** @param {object[]} usages  `details.usage` of each session in scope */
export function aggregateUsage(usages) {
  const withRecap = usages.filter((u) => u.recaps > 0);
  const memSearch = {};
  let memCalls = 0;
  let memSessions = 0;
  for (const u of usages) {
    const n = Object.values(u.memSearch ?? {}).reduce((a, b) => a + b, 0);
    if (n) memSessions++;
    memCalls += n;
    for (const [k, v] of Object.entries(u.memSearch ?? {})) memSearch[k] = (memSearch[k] ?? 0) + v;
  }
  return {
    sessions: usages.length,
    withRecap: orientation(withRecap),
    withoutRecap: orientation(usages.filter((u) => !u.recaps)),
    recapChars: mean(withRecap.map((u) => u.recapChars)),
    hints: usages.reduce((a, u) => a + (u.hints ?? 0), 0),
    sessionsWithHints: usages.filter((u) => u.hints > 0).length,
    memSearch: { calls: memCalls, sessions: memSessions, bySubcommand: memSearch },
  };
}
