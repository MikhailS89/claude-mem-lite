// Working-tree state ("is anything uncommitted?") via `git status`. This is the
// one place the plugin runs git: everything else is read straight from `.git`,
// but telling a modified file from an unmodified one means comparing the
// index with the files, which is what `git status` is for.
//
// It only runs in the Stop/SessionEnd hooks, which are asynchronous, so it
// never delays Claude Code. It is bounded by a timeout, takes no optional
// locks (so it cannot collide with the user's own git commands), and when git
// is missing or slow the recap simply has no worktree line.

import { spawnSync } from 'node:child_process';
import { isSensitivePath } from './privacy.mjs';

const TIMEOUT_MS = 3000;
/** Uncommitted paths kept per session; the count is always exact. */
const MAX_PATHS = 10;

/**
 * @param {string|null} gitRoot
 * @returns {{clean: boolean, count: number, paths: string[], hidden: number}|null}
 *          `hidden` counts sensitive files (.env and the like) left out of `paths`;
 *          null when git is unavailable, times out or fails
 */
export function readWorktree(gitRoot, { timeoutMs = TIMEOUT_MS, git = 'git' } = {}) {
  if (!gitRoot) return null;
  let r;
  try {
    r = spawnSync(git, ['status', '--porcelain=v1', '-z', '--untracked-files=normal'], {
      cwd: gitRoot,
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return null;
  }
  if (r.error || r.status !== 0 || typeof r.stdout !== 'string') return null;
  return parsePorcelainZ(r.stdout);
}

/**
 * Parse `git status --porcelain=v1 -z`: entries are `XY path\0`, and renames
 * or copies carry the original path as an extra `\0`-terminated field.
 */
export function parsePorcelainZ(out) {
  const fields = out.split('\0');
  const paths = [];
  let hidden = 0;
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (f.length < 4) continue;
    const xy = f.slice(0, 2);
    const path = f.slice(3);
    if (xy[0] === 'R' || xy[0] === 'C') i++; // skip the original path
    if (isSensitivePath(path)) hidden++;
    else paths.push(path);
  }
  const count = paths.length + hidden;
  return { clean: count === 0, count, paths: paths.slice(0, MAX_PATHS), hidden };
}
