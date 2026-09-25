// Loaded before every test file (`node --test --import ./test/setup.mjs`).
// Tests must never touch the developer's real memory: config.mjs reads
// CLAUDE_MEM_LITE_DIR once at import, so point it at a throwaway directory
// here, and drop the developer's own plugin settings (commit notes on, debug)
// so they cannot cause real model calls or log noise.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const k of Object.keys(process.env)) if (k.startsWith('CLAUDE_MEM_LITE_')) delete process.env[k];
const dir = mkdtempSync(join(tmpdir(), 'cml-test-data-'));
process.env.CLAUDE_MEM_LITE_DIR = dir;
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
