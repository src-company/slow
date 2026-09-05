#!/usr/bin/env node
/**
 * Split dapp/page.html into data-contract chunks and write deployable initcode.
 *
 * One contract would cap the page at EIP-170's 24,576 bytes. Chunking moves the
 * ceiling: the limit applies per chunk, not to the page. SlowPage takes the
 * chunk addresses as a dynamic array and reassembles them in html(), so its own
 * creation code stays small and the page can grow without editing the contract.
 *
 * Usage: node scripts/chunk.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import {ROOT, EIP170, MAX_PAYLOAD, loadManifest, readPage, split, keccak256} from './lib.mjs';

const m = loadManifest();
const {bytes, sha256} = readPage(m);
const parts = split(bytes, m.chunks?.maxPayload ?? MAX_PAYLOAD);
const pageHash = keccak256(bytes);

const out = path.join(ROOT, 'out');
fs.mkdirSync(out, {recursive: true});

/* CLEAR THE OLD SET BEFORE WRITING THE NEW ONE.
   This wrote chunk1..N and left anything above N where it was. A page that
   SHRINKS past a chunk boundary therefore left an orphan behind — `chunk11`
   from the last build, full of bytes from a page that no longer exists — and
   every consumer here globs `out/chunk*.creation.txt`. The rehearsal would
   deploy it, and so would a deployer following the same pattern by hand, on
   the one operation that cannot be taken back. Nothing warned, because from
   the outside a stale file and a fresh one are the same shape. */
const stale = fs.readdirSync(out).filter((f) => /^chunk\d+\.creation\.txt$/.test(f));
for (const f of stale) fs.rmSync(path.join(out, f));

console.log(`${m.page}: ${bytes.length.toLocaleString()} B`);
console.log(`  sha256    ${sha256}`);
console.log(`  keccak256 ${pageHash}   <- SlowPage constructor pageHash`);
console.log(`  -> ${parts.length} chunk(s)\n`);

for (const p of parts) {
  const file = path.join(out, `chunk${p.n}.creation.txt`);
  fs.writeFileSync(file, `0x${p.initcode.toString('hex')}`);
  console.log(
    `  chunk${p.n}: ${p.runtime.length.toLocaleString()} B runtime` +
    ` (${(EIP170 - p.runtime.length).toLocaleString()} B under EIP-170)` +
    ` -> out/chunk${p.n}.creation.txt`
  );
}

fs.writeFileSync(path.join(out, 'pageHash.txt'), pageHash + '\n');
const capacity = parts.length * (m.chunks?.maxPayload ?? MAX_PAYLOAD);
console.log(`\nreassembly verified.`);
console.log(`capacity at ${parts.length} chunks: ${capacity.toLocaleString()} B` +
  `  ·  headroom ${(capacity - bytes.length).toLocaleString()} B`);
