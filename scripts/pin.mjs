#!/usr/bin/env node
/**
 * Re-pin manifest.json's `bytes` and `sha256` to dapp/page.html.
 *
 * A separate, deliberate step on purpose. lib.mjs `readPage` refuses to build
 * chunks when the manifest does not match the page, and its comment says why:
 * a chunk set built from a page nobody pinned is how a deployment stops
 * matching its repo. Folding the pin into chunk.mjs would silently satisfy that
 * guard on every run and delete the check. So this is its own command, run
 * knowingly, and it shows up in review as the two-line change it is.
 *
 * The edit is a regex over the raw text, NOT a JSON round-trip. Re-encoding the
 * whole file to change two numbers rewrote the em dash in `title` as — —
 * valid JSON, identical once parsed, and a spurious diff on every release. A
 * file you only partly own should be edited only where you own it.
 *
 * Usage: node scripts/pin.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {ROOT, loadManifest} from './lib.mjs';

const m = loadManifest();
const file = path.join(ROOT, m.page);
const bytes = fs.readFileSync(file);
const sha256 = createHash('sha256').update(bytes).digest('hex');

const mpath = path.join(ROOT, 'manifest.json');
const before = fs.readFileSync(mpath, 'utf8');
const after = before
  .replace(/"bytes":\s*\d+/, `"bytes": ${bytes.length}`)
  .replace(/"sha256":\s*"[0-9a-f]{64}"/, `"sha256": "${sha256}"`);

if (after === before) {
  console.log(`already pinned: ${bytes.length.toLocaleString()} B  sha256 ${sha256.slice(0, 16)}…`);
} else {
  fs.writeFileSync(mpath, after);
  console.log(`${m.page} -> ${bytes.length.toLocaleString()} B  sha256 ${sha256.slice(0, 16)}…`);
  console.log('manifest re-pinned. Commit it with the page change it describes.');
}
