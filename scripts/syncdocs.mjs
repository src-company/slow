#!/usr/bin/env node
// Keep docs/src/README.md in step with README.md.
//
// WHY THIS EXISTS. `docs/` is `forge doc` output, and forge doc's home page is
// a copy of the project README. Nothing regenerates it, so the copy drifted:
// it sat describing the single-chain deployment for the whole of the multichain
// redeploy, naming an address that was no longer the one the dapp used. A copy
// with no copier is a copy that goes stale, and this is the copier.
//
// WHY THE LINKS ARE REWRITTEN. The README's relative links are written from the
// repo root (`./sdk`, `./assets/audit/...`). docs/src/README.md sits two levels
// down, so a verbatim copy resolves every one of them against `docs/src/` and
// breaks 24 links. Prefixing `../../` is the whole transformation; nothing else
// about the document changes, so the rendered page stays the README.
//
// `--check` reports drift without writing, which is what the test runner calls.
// Regenerating is `node scripts/syncdocs.mjs`.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(root, 'README.md');
const DST = join(root, 'docs/src/README.md');

// docs/src/README.md -> repo root. Only root-relative `./x` links need it;
// anchors, absolute URLs and mailto: are left exactly as they are.
const UP = '../../';

export function render(readme) {
  return readme.replace(/\]\(\.\/([^)]+)\)/g, (_, path) => `](${UP}${path})`);
}

const want = render(readFileSync(SRC, 'utf8'));
const check = process.argv.includes('--check');

let have = null;
try { have = readFileSync(DST, 'utf8'); } catch {}

if (have === want) {
  console.log('docs/src/README.md is in sync with README.md');
  process.exit(0);
}

if (check) {
  console.error('docs/src/README.md is out of sync with README.md');
  console.error('run: node scripts/syncdocs.mjs');
  process.exit(1);
}

writeFileSync(DST, want);
console.log(`docs/src/README.md regenerated from README.md (${want.length} bytes)`);
