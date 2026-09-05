#!/usr/bin/env node
/**
 * Build the artifact that actually gets deployed, from the page that gets read.
 *
 * WHY THERE ARE NOW TWO FILES. The page is stored as contract code at 200 gas a
 * byte, and 82,651 of its bytes are comments — 61,341 in `/* *\/` blocks and
 * 21,310 in `//` lines, about a third of what the chain is asked to hold. On
 * Robinhood Chain that third is real money: eleven chunks against seven, and
 * 0.0247 ETH against 0.0174.
 *
 * The comments are not waste in the SOURCE. They are the reason the page can be
 * reviewed at all. So they stay in `dapp/page.html`, which is what the tests
 * read and what a reader reads, and this writes `dapp/page.min.html`, which is
 * what gets pinned, chunked and deployed.
 *
 * WHAT IT DOES NOT DO, and the omissions are the point. No identifier renaming,
 * no expression rewriting, no semicolon insertion, no whitespace collapsing
 * INSIDE a line. Every one of those can change behaviour, and the artifact is
 * going to an address that cannot be corrected. This removes comments and
 * leading indentation and nothing else, which is worth four chunks and cannot
 * alter a program's meaning — newlines are preserved exactly, so automatic
 * semicolon insertion behaves identically.
 *
 * WHY A TOKENISER AND NOT A REGEX. `/\*.*?\*\/` over a whole file eats any
 * string that happens to contain the characters, and `//` appears in every URL
 * in the file. So the script is scanned properly: single and double quotes,
 * template literals with nested `${}`, and regex literals — distinguished from
 * division by the previous significant token, which is the standard heuristic
 * and the only place this is subtle.
 *
 * Comments INSIDE a `${...}` interpolation are left alone. They are vanishingly
 * rare and stripping them would mean re-entering the tokeniser mid-template for
 * a few dozen bytes.
 *
 * PRESERVED COMMENTS. A comment containing `@preserve` survives. The suite cuts
 * the script at the `Wiring` banner to separate pure logic from DOM wiring, so
 * that one banner is kept and the ENTIRE page suite then runs unchanged against
 * the artifact. That is the equivalence check: not an argument that the two
 * behave the same, but the same 600-odd assertions passing on both.
 *
 *   node scripts/minify.mjs            writes dapp/page.min.html
 *   node scripts/minify.mjs --check    exits 1 if the artifact is stale
 */
import fs from 'node:fs';
import path from 'node:path';
import {ROOT} from './lib.mjs';

const KEEP = /@preserve|Wiring/;

/** Strip comments from a JavaScript source, leaving everything else alone. */
export function stripJs(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  // The last significant character, for telling `/` regex from `/` division.
  let prev = '';
  const tmpl = []; // depth stack for `${ }` inside template literals
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];

    // ── comments ────────────────────────────────────────────────────────
    if (c === '/' && d === '/') {
      let j = src.indexOf('\n', i);
      if (j < 0) j = n;
      const text = src.slice(i, j);
      if (KEEP.test(text)) out += text;
      i = j;
      continue;
    }
    if (c === '/' && d === '*') {
      const j = src.indexOf('*/', i + 2);
      const end = j < 0 ? n : j + 2;
      const text = src.slice(i, end);
      if (KEEP.test(text)) out += text;
      i = end;
      continue;
    }

    // ── strings ─────────────────────────────────────────────────────────
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === c) break;
        j++;
      }
      out += src.slice(i, j + 1);
      prev = c;
      i = j + 1;
      continue;
    }

    // ── template literals, including nested ${ } ────────────────────────
    if (c === '`') {
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '`') break;
        if (src[j] === '$' && src[j + 1] === '{') {
          // Recurse over the interpolation so comments inside it are stripped
          // too, and so a `}` in a nested string does not end it early.
          let depth = 1;
          let k = j + 2;
          while (k < n && depth > 0) {
            const ch = src[k];
            if (ch === '{') depth++;
            else if (ch === '}') depth--;
            else if (ch === "'" || ch === '"' || ch === '`') {
              const q = ch;
              k++;
              while (k < n) {
                if (src[k] === '\\') { k += 2; continue; }
                if (src[k] === q) break;
                k++;
              }
            }
            k++;
          }
          // Only SCAN past the interpolation; the whole template is emitted
          // once at the end. Emitting here as well is how this first shipped,
          // and it duplicated every `${...}` ahead of the literal that
          // contained it — which parses as a syntax error rather than as
          // wrong output, so the equivalence run caught it immediately.
          j = k;
          continue;
        }
        j++;
      }
      out += src.slice(i, j + 1);
      prev = '`';
      i = j + 1;
      continue;
    }

    // ── regex literals ──────────────────────────────────────────────────
    if (c === '/') {
      // A `/` is a regex only when what precedes it cannot end an expression.
      const regexOk = !/[A-Za-z0-9_$)\]}]/.test(prev);
      if (regexOk) {
        let j = i + 1;
        let inClass = false;
        while (j < n) {
          const ch = src[j];
          if (ch === '\\') { j += 2; continue; }
          if (ch === '[') inClass = true;
          else if (ch === ']') inClass = false;
          else if (ch === '/' && !inClass) break;
          else if (ch === '\n') break; // unterminated: not a regex after all
          j++;
        }
        if (src[j] === '/') {
          let k = j + 1;
          while (k < n && /[a-z]/.test(src[k])) k++; // flags
          out += src.slice(i, k);
          prev = '/';
          i = k;
          continue;
        }
      }
    }

    out += c;
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}

/** CSS has only block comments, and no regex or template literals to confuse. */
export function stripCss(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '*') {
      const j = src.indexOf('*/', i + 2);
      i = j < 0 ? src.length : j + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === c) break;
        j++;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Leading indentation and runs of blank lines. Newlines themselves stay. */
const squeeze = (s) => s.replace(/^[ \t]+/gm, '').replace(/\n{2,}/g, '\n');

export function minify(html) {
  const region = (tag, fn) => {
    const open = html.indexOf(`<${tag}`);
    if (open < 0) return;
    const start = html.indexOf('>', open) + 1;
    const end = html.indexOf(`</${tag}>`, start);
    html = html.slice(0, start) + squeeze(fn(html.slice(start, end))) + html.slice(end);
  };
  region('style', stripCss);
  region('script', stripJs);
  // HTML comments last, so nothing above has to care about them.
  html = html.replace(/<!--(?!\[if)[\s\S]*?-->/g, '');
  return html;
}

const SRC = path.join(ROOT, 'dapp/page.html');
const OUT = path.join(ROOT, 'dapp/page.min.html');

const built = minify(fs.readFileSync(SRC, 'utf8'));

if (process.argv.includes('--check')) {
  const have = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : null;
  if (have !== built) {
    console.error('dapp/page.min.html is stale — run: node scripts/minify.mjs');
    process.exit(1);
  }
  console.log('artifact is current');
  process.exit(0);
}

fs.writeFileSync(OUT, built);
const a = Buffer.byteLength(fs.readFileSync(SRC, 'utf8'));
const b = Buffer.byteLength(built);
const chunks = (n) => Math.ceil(n / 24575);
console.log(`dapp/page.html      ${a.toLocaleString()} B  -> ${chunks(a)} chunks`);
console.log(`dapp/page.min.html  ${b.toLocaleString()} B  -> ${chunks(b)} chunks` +
  `   saves ${(a - b).toLocaleString()} B and ${chunks(a) - chunks(b)} chunks`);
