import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { filesReadByCommand, simpleCommands } from '../src/shell.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'cml-shell-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
mkdirSync(join(tmp, 'src'), { recursive: true });
for (const f of ['src/a.ts', 'src/b.ts', 'README.md', 'my file.md']) writeFileSync(join(tmp, f), 'x');

test('simpleCommands splits at && || ; | and newlines, but not inside quotes', () => {
  assert.deepEqual(simpleCommands('cd x && npm test | tail -5; echo "a && b | c" || true\nls'), ['cd x', 'npm test', 'tail -5', 'echo "a && b | c"', 'true', 'ls']);
  assert.deepEqual(simpleCommands("grep -E 'a|b' f"), ["grep -E 'a|b' f"]);
});

test('filesReadByCommand finds files read by cat and sed, following cd', () => {
  const found = (cmd, cwd = tmp) => filesReadByCommand(cmd, cwd).map((p) => p.slice(tmp.length + 1).replace(/\\/g, '/')).sort();
  assert.deepEqual(found('cat src/a.ts'), ['src/a.ts']);
  assert.deepEqual(found(`cd "${join(tmp, 'src')}" && cat a.ts b.ts`), ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(found("sed -n '1,40p' README.md"), ['README.md'], 'the sed script is not a file');
  assert.deepEqual(found("sed -i 's/a/b/' src/a.ts"), ['src/a.ts']);
  assert.deepEqual(found("sed -e 's/a/b/' -e 's/c/d/' src/b.ts"), ['src/b.ts']);
  assert.deepEqual(found('cat "my file.md" | grep x'), ['my file.md']);
  assert.deepEqual(found('npm test | tail -5 && head -3 README.md'), [], 'head and tail are not covered');
  assert.deepEqual(found('cat src/missing.ts src/*.ts -'), [], 'only existing files, no globs or stdin');
});
