// Project identity. We never spawn `git` (slow on Windows, may be missing):
// the repository root is found by walking up from cwd, and the origin URL,
// HEAD and recent commits are read straight from the files under `.git`.
//
// Identifier precedence:
//   1. `git:<host>/<owner>/<repo>` - normalised origin URL (survives moving the folder)
//   2. `path:<repo root>`          - repository without a remote
//   3. `path:<cwd>`                - not a git repository at all

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { inflateSync } from 'node:zlib';

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

/**
 * Commits reachable from `fromSha` along first parents, newest first, read
 * straight from loose objects under `.git/objects` (no `git` process).
 * Freshly made commits are loose until `git gc` packs them; the walk simply
 * stops at the first object that is not loose, so it may return fewer
 * commits than exist but never wrong ones.
 * @param {string} gitRoot
 * @param {string|null} fromSha
 * @param {{since?: number|null, max?: number}} [opts] stop at commits whose
 *        committer time (ms) is before `since`
 * @returns {{sha: string, subject: string, time: number}[]} oldest first
 */
export function readCommits(gitRoot, fromSha, { since = null, max = 50 } = {}) {
  const dirs = gitRoot && fromSha ? gitDirs(gitRoot) : null;
  if (!dirs) return [];
  const out = [];
  const seen = new Set();
  let sha = fromSha.toLowerCase();
  while (sha && out.length < max && !seen.has(sha)) {
    seen.add(sha);
    const c = readLooseCommit(dirs.commonDir, sha);
    if (!c || (since !== null && c.time < since)) break;
    out.push({ sha, subject: c.subject, time: c.time });
    sha = c.parent;
  }
  return out.reverse();
}

/**
 * Build a check for whether an object (full or abbreviated sha) exists in the
 * repo, loose or in a pack. Used to drop commits the transcript shows being
 * made in some other repository. Returns null outside a repository.
 * @returns {((sha: string) => boolean)|null}
 */
export function objectLookup(gitRoot) {
  const dirs = gitRoot ? gitDirs(gitRoot) : null;
  if (!dirs) return null;
  const objects = join(dirs.commonDir, 'objects');
  let packs = null; // pack indexes are read lazily, once
  return (sha) => {
    const s = String(sha).toLowerCase();
    if (!/^[0-9a-f]{4,64}$/.test(s)) return false;
    try {
      if (readdirSync(join(objects, s.slice(0, 2))).some((f) => f.startsWith(s.slice(2)))) return true;
    } catch {
      // no loose objects with this first byte
    }
    packs ??= readPackIndexes(join(objects, 'pack'));
    return packs.some((idx) => packHas(idx, s));
  };
}

/** Pack index (v2) files as buffers; unreadable or v1 indexes are skipped. */
function readPackIndexes(packDir) {
  let names = [];
  try {
    names = readdirSync(packDir).filter((f) => f.endsWith('.idx'));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    try {
      const buf = readFileSync(join(packDir, name));
      if (buf.readUInt32BE(0) === 0xff744f63 && buf.readUInt32BE(4) === 2) out.push(buf);
    } catch {
      // skip
    }
  }
  return out;
}

/** Binary search a v2 pack index for an object whose name starts with `hex`. */
function packHas(idx, hex) {
  const width = 20; // SHA-1; SHA-256 repositories use a different index layout
  const first = parseInt(hex.slice(0, 2), 16);
  let lo = first === 0 ? 0 : idx.readUInt32BE(8 + (first - 1) * 4);
  let hi = idx.readUInt32BE(8 + first * 4);
  const names = 8 + 256 * 4;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const name = idx.toString('hex', names + mid * width, names + (mid + 1) * width);
    if (name.startsWith(hex)) return true;
    if (name < hex) lo = mid + 1;
    else hi = mid;
  }
  return false;
}

/** Inflate and parse one loose commit object; null if missing, packed or not a commit. */
function readLooseCommit(commonDir, sha) {
  let raw;
  try {
    raw = inflateSync(readFileSync(join(commonDir, 'objects', sha.slice(0, 2), sha.slice(2))));
  } catch {
    return null;
  }
  const nul = raw.indexOf(0);
  if (nul === -1 || !raw.subarray(0, nul).toString('latin1').startsWith('commit ')) return null;
  const text = raw.subarray(nul + 1).toString('utf8');
  const sep = text.indexOf('\n\n');
  const header = sep === -1 ? text : text.slice(0, sep);
  const message = sep === -1 ? '' : text.slice(sep + 2);
  const committed = /^committer .* (\d+) [+-]\d{4}$/m.exec(header);
  if (!committed) return null;
  return {
    parent: /^parent ([0-9a-f]{40,64})$/m.exec(header)?.[1] ?? null,
    time: Number(committed[1]) * 1000,
    subject: message.split('\n').find((l) => l.trim())?.trim() ?? '',
  };
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
