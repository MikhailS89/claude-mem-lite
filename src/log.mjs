// Append-only log file. Hooks must never write noise to stdout/stderr (stdout
// is parsed by Claude Code), so diagnostics go here instead.

import { appendFileSync, mkdirSync } from 'node:fs';
import { dataDir, debug, logPath } from './config.mjs';

function write(level, msg, extra) {
  try {
    mkdirSync(dataDir, { recursive: true });
    const line = `${new Date().toISOString()} [${level}] ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}\n`;
    appendFileSync(logPath, line, 'utf8');
  } catch {
    // Logging must never throw.
  }
}

export function logError(msg, err) {
  const extra = err instanceof Error ? { error: err.message, stack: err.stack } : err;
  write('error', msg, extra);
}

export function logDebug(msg, extra) {
  if (debug) write('debug', msg, extra);
}
