// Parser for Claude Code transcript files (`~/.claude/projects/<proj>/<session>.jsonl`).
//
// One JSON object per line. Records we care about:
//   type=user      message.content = [{type:"text"}]      -> a human prompt
//                  message.content = [{type:"tool_result"}] -> tool output (ignored)
//   type=assistant message.content = [{type:"text"|"tool_use"|"thinking"}]
//   type=ai-title  aiTitle                                -> session title
// Records flagged `isSidechain` belong to subagents and are skipped; `isMeta`
// records are Claude Code's own bookkeeping (slash-command caveats etc.).

import { readFileSync } from 'node:fs';

/** Text blocks Claude Code injects into user turns that are not the user's words. */
const INJECTED_BLOCK = /^\s*<(system-reminder|ide_opened_file|ide_selection|ide_diagnostics|local-command-caveat|local-command-stdout|local-command-stderr|command-name|command-message|command-args|task-notification|user-prompt-submit-hook|antml:document|document)\b/i;

/** Tools that identify a file in their input. `kind` is what we record. */
const FILE_TOOLS = {
  Read: { field: 'file_path', kind: 'read' },
  Edit: { field: 'file_path', kind: 'edit' },
  MultiEdit: { field: 'file_path', kind: 'edit' },
  Write: { field: 'file_path', kind: 'write' },
  NotebookEdit: { field: 'notebook_path', kind: 'edit' },
};

/**
 * @typedef {object} ParsedTranscript
 * @property {string|null} sessionId
 * @property {string|null} cwd
 * @property {string|null} branch
 * @property {string|null} title
 * @property {string|null} startedAt   ISO timestamp of the first record
 * @property {string|null} endedAt     ISO timestamp of the last record
 * @property {{ts:string, text:string}[]} prompts
 * @property {{ts:string, name:string, input:object}[]} toolUses
 * @property {{ts:string, text:string}[]} assistantTexts  final text of each assistant turn
 * @property {number} lines  number of lines successfully parsed
 */

/** Parse a transcript file. Missing/partial lines are tolerated. */
export function parseTranscriptFile(path) {
  return parseTranscript(readFileSync(path, 'utf8'));
}

/** @returns {ParsedTranscript} */
export function parseTranscript(text) {
  const out = {
    sessionId: null,
    cwd: null,
    branch: null,
    title: null,
    startedAt: null,
    endedAt: null,
    prompts: [],
    toolUses: [],
    assistantTexts: [],
    lines: 0,
  };

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // partial last line while the session is still being written
    }
    out.lines++;
    if (typeof rec !== 'object' || rec === null) continue;

    if (rec.type === 'ai-title' && typeof rec.aiTitle === 'string') {
      out.title = rec.aiTitle.trim() || out.title;
      continue;
    }
    if (rec.type !== 'user' && rec.type !== 'assistant') continue;
    if (rec.isSidechain) continue;

    out.sessionId ??= rec.sessionId ?? null;
    out.cwd ??= rec.cwd ?? null;
    if (rec.gitBranch && rec.gitBranch !== 'HEAD') out.branch = rec.gitBranch;
    if (rec.timestamp) {
      out.startedAt ??= rec.timestamp;
      out.endedAt = rec.timestamp;
    }

    const content = rec.message?.content;
    if (rec.type === 'user') {
      if (rec.isMeta) continue;
      const prompt = extractPrompt(content);
      if (prompt) out.prompts.push({ ts: rec.timestamp ?? '', text: prompt });
      continue;
    }

    // assistant
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === 'tool_use' && typeof block.name === 'string') {
        out.toolUses.push({ ts: rec.timestamp ?? '', name: block.name, input: block.input ?? {} });
      } else if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        out.assistantTexts.push({ ts: rec.timestamp ?? '', text: block.text.trim() });
      }
    }
  }
  return out;
}

/** Join the user's own text blocks, ignoring everything Claude Code injected. */
function extractPrompt(content) {
  if (typeof content === 'string') {
    return INJECTED_BLOCK.test(content) ? '' : content.trim();
  }
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue;
    if (INJECTED_BLOCK.test(block.text)) continue;
    const t = block.text.trim();
    if (t) parts.push(t);
  }
  return parts.join('\n');
}

/**
 * Derive per-tool facts from a tool_use block.
 * @returns {{file?: {path:string, kind:string}, command?: string, search?: string}}
 */
export function describeToolUse(name, input) {
  const spec = FILE_TOOLS[name];
  if (spec) {
    const p = input?.[spec.field];
    return typeof p === 'string' && p ? { file: { path: p, kind: spec.kind } } : {};
  }
  if (name === 'Bash' && typeof input?.command === 'string') return { command: input.command };
  if ((name === 'Grep' || name === 'Glob') && typeof input?.pattern === 'string') return { search: input.pattern };
  return {};
}
