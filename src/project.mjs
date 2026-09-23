// Project identity. We never spawn `git` (slow on Windows, may be missing):
// the repository root is found by walking up from cwd, and the origin URL and
// HEAD are read straight from the files under `.git`.
//
// Identifier precedence:
//   1. `git:<host>/<owner>/<repo>` - normalised origin URL (survives moving the folder)
//   2. `path:<repo root>`          - repository without a remote
//   3. `path:<cwd>`                - not a git repository at all

import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

/** Walk up from `start` until a directory containing `.git` is found. */
export function findGitRoot(start) {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Resolve the git directories of the repo at `gitRoot`: `gitDir` holds this
 * checkout's HEAD, `commonDir` holds `config`, `refs/` and `packed-refs`
 * (they differ only for linked worktrees).
 * @returns {{gitDir: string, commonDir: string}|null}
 */
function gitDirs(gitRoot) {
  const dotGit = join(gitRoot, '.git');
  let gitDir = dotGit;
  try {
    if (statSync(dotGit).isFile()) {
      // Worktree / submodule: `.git` is a file with `gitdir: <path>`.
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'));
      if (!m) return null;
      gitDir = isAbsolute(m[1].trim()) ? m[1].trim() : resolve(gitRoot, m[1].trim());
    }
    let commonDir = gitDir;
    const commonFile = join(gitDir, 'commondir');
    if (existsSync(commonFile)) {
      const common = readFileSync(commonFile, 'utf8').trim();
      commonDir = isAbsolute(common) ? common : resolve(gitDir, common);
    }
    return { gitDir, commonDir };
  } catch {
    return null;
  }
}

function gitCommonDir(gitRoot) {
  return gitDirs(gitRoot)?.commonDir ?? null;
}

/**
 * Read the current HEAD straight from `.git` (no `git` process).
 * `ref` is the branch name, or null when HEAD is detached; `sha` is null on
 * an unborn branch (no commits yet).
 * @returns {{ref: string|null, sha: string|null}|null} null when not a repo
 */
export function readHead(gitRoot) {
  if (!gitRoot) return null;
  const dirs = gitDirs(gitRoot);
  if (!dirs) return null;
  let head;
  try {
    head = readFileSync(join(dirs.gitDir, 'HEAD'), 'utf8').trim();
  } catch {
    return null;
  }
  const sym = /^ref:\s*(\S+)$/.exec(head);
  if (!sym) return /^[0-9a-f]{40,64}$/i.test(head) ? { ref: null, sha: head.toLowerCase() } : null;
  const ref = sym[1];
  return { ref: ref.replace(/^refs\/heads\//, ''), sha: resolveRef(dirs, ref) };
}

function resolveRef({ gitDir, commonDir }, ref) {
  for (const dir of new Set([gitDir, commonDir])) {
    try {
      const sha = readFileSync(join(dir, ...ref.split('/')), 'utf8').trim();
      if (/^[0-9a-f]{40,64}$/i.test(sha)) return sha.toLowerCase();
    } catch {
      // not a loose ref here
    }
  }
  try {
    for (const line of readFileSync(join(commonDir, 'packed-refs'), 'utf8').split(/\r?\n/)) {
      const m = /^([0-9a-f]{40,64}) (\S+)$/i.exec(line);
      if (m && m[2] === ref) return m[1].toLowerCase();
    }
  } catch {
    // no packed-refs
  }
  return null;
}

/** Parse `.git/config` and return the URL of remote "origin" (or the first remote). */
export function readRemoteUrl(gitRoot) {
  const gitDir = gitCommonDir(gitRoot);
  if (!gitDir) return null;
  let text;
  try {
    text = readFileSync(join(gitDir, 'config'), 'utf8');
  } catch {
    return null;
  }
  const remotes = new Map();
  let section = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const sec = /^\[remote\s+"([^"]+)"\]$/.exec(line);
    if (sec) {
      section = sec[1];
      continue;
    }
    if (line.startsWith('[')) {
      section = null;
      continue;
    }
    if (section === null) continue;
    const kv = /^url\s*=\s*(.+)$/.exec(line);
    if (kv) remotes.set(section, kv[1].trim());
  }
  return remotes.get('origin') ?? remotes.values().next().value ?? null;
}

/**
 * Normalise a remote URL to `host/owner/repo` so that ssh and https clones of
 * the same repository share one identity. Credentials embedded in the URL are
 * dropped and never stored.
 */
export function normalizeRemote(url) {
  let s = url.trim();
  // scp-like syntax: git@github.com:owner/repo.git (no "://" anywhere)
  const scp = s.includes('://') ? null : /^(?:[^@\s]+@)?([^:/\s]+):(.+)$/.exec(s);
  if (scp) {
    s = `${scp[1]}/${scp[2]}`;
  } else {
    s = s.replace(/^[a-z+]+:\/\//i, ''); // protocol
    s = s.replace(/^[^@/]+@/, ''); // user[:password]@
    s = s.replace(/^([^/:]+):\d+\//, '$1/'); // :port
  }
  s = s.replace(/\/+$/, '').replace(/\.git$/i, '');
  const slash = s.indexOf('/');
  const host = (slash === -1 ? s : s.slice(0, slash)).toLowerCase();
  const path = slash === -1 ? '' : s.slice(slash);
  return host + path;
}

/** Normalise a filesystem path for use as an identifier. */
function normalizePath(p) {
  let s = resolve(p).replace(/\\/g, '/');
  if (process.platform === 'win32') s = s.toLowerCase();
  return s;
}

/**
 * @param {string} cwd
 * @returns {{ id: string, root: string, name: string, remote: string|null }}
 */
export function resolveProject(cwd) {
  const root = findGitRoot(cwd) ?? resolve(cwd);
  const remote = findGitRoot(cwd) ? readRemoteUrl(root) : null;
  if (remote) {
    const norm = normalizeRemote(remote);
    return { id: `git:${norm}`, root, name: basename(norm), remote: norm };
  }
  return { id: `path:${normalizePath(root)}`, root, name: basename(root), remote: null };
}
