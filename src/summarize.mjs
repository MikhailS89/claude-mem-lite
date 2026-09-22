// Heuristic (no LLM) compression of a parsed transcript into:
//   - `summary`: one short paragraph, the "index level" shown on SessionStart
//   - `details`: structured JSON, the "detail level" returned by `show`
//   - `files`:   per-file touch counts for the session_files table

import { homedir } from 'node:os';
import { isAbsolute, relative } from 'node:path';
import { limits } from './config.mjs';
import { isSensitivePath, sanitize, truncate } from './privacy.mjs';
import { describeToolUse } from './transcript.mjs';

/**
 * Make a path relative to the project root (or `~` for the home directory)
 * and use forward slashes.
 */
export function displayPath(filePath, projectRoot, home = homedir()) {
  let p = String(filePath);
  if (isAbsolute(p)) {
    const relProject = projectRoot ? relative(projectRoot, p) : '';
    const relHome = home ? relative(home, p) : '';
    if (relProject && !relProject.startsWith('..') && !isAbsolute(relProject)) p = relProject;
    else if (relHome && !relHome.startsWith('..') && !isAbsolute(relHome)) p = '~/' + relHome;
  }
  return p.replace(/\\/g, '/');
}

/** Dedupe a list of strings preserving first occurrence order. */
function uniq(list) {
  return [...new Set(list)];
}

/**
 * @param {import('./transcript.mjs').ParsedTranscript} t
 * @param {{root: string}} project
 */
export function summarize(t, project) {
  const root = project?.root ?? null;

  // --- files ---------------------------------------------------------------
  /** @type {Map<string, {path:string, kind:string, ops:number}>} */
  const files = new Map();
  const commands = [];
  const searches = [];
  const tools = {};
  let sensitiveTouches = 0;

  for (const use of t.toolUses) {
    tools[use.name] = (tools[use.name] ?? 0) + 1;
    const d = describeToolUse(use.name, use.input);
    if (d.file) {
      if (isSensitivePath(d.file.path)) {
        sensitiveTouches++;
        continue;
      }
      const key = displayPath(d.file.path, root);
      const cur = files.get(key) ?? { path: key, kind: 'read', ops: 0 };
      cur.ops++;
      // edit/write outranks read
      if (d.file.kind !== 'read') cur.kind = cur.kind === 'read' ? d.file.kind : cur.kind;
      files.set(key, cur);
    } else if (d.command) {
      commands.push(truncate(sanitize(d.command), limits.commandChars));
    } else if (d.search) {
      searches.push(truncate(sanitize(d.search), 80));
    }
  }

  // Project-relative paths first, then `~/...`, then anything else absolute.
  const fileList = [...files.values()].sort((a, b) => pathRank(a.path) - pathRank(b.path));
  const edited = fileList.filter((f) => f.kind !== 'read').map((f) => f.path);
  const read = fileList.filter((f) => f.kind === 'read').map((f) => f.path);

  // --- prompts & outcome -----------------------------------------------------
  const prompts = t.prompts
    .map((p) => ({ ts: p.ts, text: truncate(sanitize(p.text), limits.promptChars) }))
    .filter((p) => p.text && p.text !== '[private]');
  const outcome = t.assistantTexts.length
    ? truncate(sanitize(t.assistantTexts[t.assistantTexts.length - 1].text), limits.outcomeChars)
    : '';

  const firstPrompt = prompts[0]?.text ?? '';
  const lastPrompt = prompts[prompts.length - 1]?.text ?? '';
  const title = t.title ? truncate(sanitize(t.title), 120) : truncate(firstPrompt, 80);

  // --- stats -----------------------------------------------------------------
  const durationMin =
    t.startedAt && t.endedAt ? Math.max(0, Math.round((Date.parse(t.endedAt) - Date.parse(t.startedAt)) / 60000)) : null;
  const stats = {
    prompts: t.prompts.length,
    toolCalls: t.toolUses.length,
    filesEdited: edited.length,
    filesRead: read.length,
    commands: commands.length,
    durationMin,
    sensitiveTouches,
  };

  // --- index-level summary ---------------------------------------------------
  const parts = [];
  if (title) parts.push(title);
  parts.push(`${stats.prompts} prompt${stats.prompts === 1 ? '' : 's'}, ${stats.toolCalls} tool calls`);
  if (edited.length) parts.push(`edited: ${listPreview(edited, 6)}`);
  else if (read.length) parts.push(`read: ${listPreview(read, 4)}`);
  const cmdPreview = uniq(commands.map(commandHead)).filter(Boolean);
  if (cmdPreview.length) parts.push(`ran: ${listPreview(cmdPreview, 5)}`);
  if (lastPrompt && lastPrompt !== firstPrompt) parts.push(`last request: "${truncate(lastPrompt, 140)}"`);
  else if (firstPrompt && !t.title) parts.push(`request: "${truncate(firstPrompt, 140)}"`);
  if (outcome) parts.push(`outcome: "${truncate(outcome, 200)}"`);
  const summary = parts.join(' · ');

  const details = {
    title,
    prompts: prompts.slice(-limits.prompts),
    filesEdited: edited.slice(0, limits.files),
    filesRead: read.slice(0, limits.files),
    commands: uniq(commands).slice(-limits.commands),
    searches: uniq(searches).slice(0, 20),
    tools,
    outcome,
    stats,
  };

  return { title, summary, details, files: fileList.slice(0, limits.files), stats };
}

/** "npm test", "git commit", "node scripts/x.mjs" - the first one or two words of a command. */
export function commandHead(cmd) {
  let s = String(cmd).trim();
  s = s.replace(/^[(\s]+/, ''); // subshell "(a; b)"
  s = s.replace(/^(cd\s+("[^"]*"|'[^']*'|\S+)\s*(&&|;)\s*)+/, ''); // "cd <dir> && ..."
  s = s.replace(/^(\w+=("[^"]*"|'[^']*'|\S+)\s+)+/, ''); // "FOO=bar cmd"
  const words = s.split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  const first = words[0].replace(/^.*[\\/]/, '');
  const subcommandTools = new Set(['git', 'npm', 'pnpm', 'yarn', 'bun', 'docker', 'cargo', 'go', 'dotnet', 'pip', 'python', 'node', 'make', 'gh', 'kubectl', 'composer', 'php']);
  if (subcommandTools.has(first) && words[1] && !words[1].startsWith('-')) return `${first} ${words[1]}`;
  return first;
}

function pathRank(p) {
  if (p.startsWith('~/')) return 1;
  if (isAbsolute(p) || /^[a-z]:\//i.test(p)) return 2;
  return 0;
}

function listPreview(items, max) {
  const shown = items.slice(0, max).join(', ');
  return items.length > max ? `${shown} (+${items.length - max})` : shown;
}
