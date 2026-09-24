// Runtime configuration. Everything is driven by environment variables so the
// plugin never needs a config file, and every knob is documented in README.md.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const env = process.env;

function intEnv(name, fallback) {
  const n = Number.parseInt(env[name] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function boolEnv(name, fallback) {
  const v = (env[name] ?? '').trim().toLowerCase();
  if (v === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(v);
}

/** Directory that holds the database and the log file. */
export const dataDir = env.CLAUDE_MEM_LITE_DIR || join(homedir(), '.claude-mem-lite');

export const dbPath = join(dataDir, 'memory.db');
export const logPath = join(dataDir, 'hooks.log');

/** Global kill switch: CLAUDE_MEM_LITE_ENABLED=false disables every hook. */
export const enabled = boolEnv('CLAUDE_MEM_LITE_ENABLED', true);

/** Verbose logging to hooks.log (errors are always logged). */
export const debug = boolEnv('CLAUDE_MEM_LITE_DEBUG', false);

/**
 * Run `git status` after each turn to record uncommitted changes (the only
 * git process the plugin starts). Turn off for repositories where it is slow.
 */
export const gitStatus = boolEnv('CLAUDE_MEM_LITE_GIT_STATUS', true);

/**
 * Summarise each commit's work ("what" and "why") with a small model, through
 * the user's own Claude Code (`claude -p`). Off by default: it spends the
 * user's quota, measured at about $0.01-0.015 and 10-20 s per commit with Haiku.
 */
export const llmSummary = boolEnv('CLAUDE_MEM_LITE_LLM_SUMMARY', false);

/** Model for commit summaries (any `claude --model` value). */
export const llmModel = env.CLAUDE_MEM_LITE_LLM_MODEL || 'haiku';

/** Path to the `claude` executable, when it cannot be found automatically. */
export const claudeBin = env.CLAUDE_MEM_LITE_CLAUDE_BIN || null;

/** How many recent sessions SessionStart injects. */
export const recallSessions = intEnv('CLAUDE_MEM_LITE_RECALL_SESSIONS', 5);

/**
 * Hard cap on the injected recap size (characters, ~4 chars per token).
 * The recap is paid for in every session, so even an explicit setting is
 * clamped. Should anything cut it further, the recap contains no surrogate
 * pairs to split (see bmpSafe in privacy.mjs).
 */
export const recallMaxChars = Math.min(intEnv('CLAUDE_MEM_LITE_CONTEXT_CHARS', 4000), 9000);

/** Per-item caps for what gets stored in the database. */
export const limits = {
  prompts: intEnv('CLAUDE_MEM_LITE_MAX_PROMPTS', 30),
  promptChars: intEnv('CLAUDE_MEM_LITE_PROMPT_CHARS', 400),
  commands: intEnv('CLAUDE_MEM_LITE_MAX_COMMANDS', 40),
  commandChars: intEnv('CLAUDE_MEM_LITE_COMMAND_CHARS', 200),
  files: intEnv('CLAUDE_MEM_LITE_MAX_FILES', 200),
  outcomeChars: intEnv('CLAUDE_MEM_LITE_OUTCOME_CHARS', 600),
  commits: 30,
};

/**
 * Per-project opt-out: an empty marker file at
 * `<project-root>/.claude-mem-lite/disabled` turns the plugin off for that
 * project only (add the directory to .gitignore or commit it - your call).
 */
export function isDisabledForProject(projectRoot) {
  if (!projectRoot) return false;
  return existsSync(join(projectRoot, '.claude-mem-lite', 'disabled'));
}
