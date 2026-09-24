// Just enough shell parsing to see which files a Bash command touches: split a
// command line into simple commands, follow `cd`, and split words honouring
// quotes. Not a shell: no variables, globs, subshells or here-docs. Used for
// rework detection (what a command deleted) and file hints (what it read).

import { statSync } from 'node:fs';
import { resolve } from 'node:path';

/** Git Bash writes Windows paths as /c/Users/...; Node needs C:/Users/... */
export function nativePath(p) {
  return process.platform === 'win32' ? p.replace(/^\/([a-z])(?=\/|$)/i, '$1:') : p;
}

/** Split a command into words, honouring simple single and double quotes. */
export function shellWords(s) {
  const out = [];
  for (const m of String(s).matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/**
 * Split a command line into simple commands at `&&`, `||`, `;`, `|` and
 * newlines outside quotes.
 */
export function simpleCommands(command) {
  const s = String(command);
  const out = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
      cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      cur += c;
    } else if (c === ';' || c === '\n' || c === '|' || (c === '&' && s[i + 1] === '&')) {
      if (c === '&' || (c === '|' && s[i + 1] === '|')) i++;
      out.push(cur.trim());
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur.trim());
  return out.filter(Boolean);
}

/**
 * Walk the simple commands of a command line with the directory each one
 * runs in (following `cd <dir>`).
 * @param {(words: string[], dir: string) => void} visit
 */
export function walkCommand(command, cwd, visit) {
  let dir = cwd;
  for (const part of simpleCommands(command)) {
    const words = shellWords(part);
    if (!words.length) continue;
    if (words[0] === 'cd' && words[1]) {
      dir = resolve(dir, nativePath(words[1]));
      continue;
    }
    visit(words, dir);
  }
}

/**
 * Absolute paths of existing files that a command reads or edits with `cat`
 * or `sed` (`sed -n '1,20p' f`, `sed -i 's/a/b/' f`). The sed script is the
 * first non-option argument unless given with -e / -f.
 * @returns {string[]}
 */
export function filesReadByCommand(command, cwd) {
  const out = new Set();
  walkCommand(command, cwd, (words, dir) => {
    const cmd = words[0].replace(/^.*[\\/]/, '');
    let args = [];
    if (cmd === 'cat') {
      args = words.slice(1).filter((w) => !w.startsWith('-'));
    } else if (cmd === 'sed') {
      let scriptGiven = false;
      const rest = [];
      for (let i = 1; i < words.length; i++) {
        const w = words[i];
        if (w === '-e' || w === '-f' || w === '--expression' || w === '--file') {
          scriptGiven = true;
          i++;
        } else if (!w.startsWith('-') || w === '-') rest.push(w);
      }
      args = scriptGiven ? rest : rest.slice(1);
    }
    for (const a of args) {
      if (!a || a === '-' || /[*?<>]/.test(a)) continue;
      const abs = resolve(dir, nativePath(a));
      try {
        if (statSync(abs).isFile()) out.add(abs);
      } catch {
        // not a file (yet): nothing to say about it
      }
    }
  });
  return [...out];
}
