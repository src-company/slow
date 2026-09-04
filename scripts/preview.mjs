#!/usr/bin/env node
/**
 * Publish dapp/page.html to the `gh-pages` branch as index.html, for a link you
 * can open in a real browser with a real wallet.
 *
 * Uses git plumbing, so it never touches the working tree or checks anything
 * out: the page is hashed straight into an orphan commit and force-pushed. The
 * page is read through the manifest, so a preview is always a pinned build.
 *
 * Usage: node scripts/preview.mjs [remote]
 */
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import {ROOT, loadManifest, readPage} from './lib.mjs';

const git = (...a) => execFileSync('git', a, {cwd: ROOT, encoding: 'utf8'}).trim();
const remote = process.argv[2] || 'origin';

const m = loadManifest();
const {bytes, sha256} = readPage(m);

const blob = git('hash-object', '-w', path.join(ROOT, m.page));
const nojekyll = execFileSync('git', ['hash-object', '-w', '--stdin'], {cwd: ROOT, input: '', encoding: 'utf8'}).trim();

// The render gallery rides along when it has been built. It is a build product,
// not a source file, so it is not committed — but it belongs next to the page it
// documents, on the same pinned commit, so the two can never disagree.
const entries = [`100644 blob ${blob}\tindex.html`, `100644 blob ${nojekyll}\t.nojekyll`];
const galleryPath = path.join(ROOT, 'preview/gallery.html');
let gallery = false;
if (fs.existsSync(galleryPath)) {
  entries.push(`100644 blob ${git('hash-object', '-w', galleryPath)}\tgallery.html`);
  gallery = true;
}

// The Take-view scenarios: states that are hard to reach on chain — a transfer
// a minute from unlocking, one past its recovery window, one bridged in under
// an address alias — captured from the real UI. An index, the sheets, and the
// shots they reference, all under scenarios/.
const scnDir = path.join(ROOT, 'preview/scenarios');
let scenarios = false;
if (fs.existsSync(scnDir)) {
  const sub = [];
  for (const f of fs.readdirSync(scnDir).sort()) {
    if (f === '_harness.html' || (!f.endsWith('.png') && !f.endsWith('.html'))) continue;
    sub.push(`100644 blob ${git('hash-object', '-w', path.join(scnDir, f))}\t${f}`);
  }
  const sheets = fs.readdirSync(scnDir).filter((f) => f.startsWith('sheet-')).sort();
  if (sheets.length) {
    const idx = `<title>SLOW · Take scenarios</title><style>body{font:14px system-ui;
      background:#111;color:#eee;padding:32px;line-height:1.7}a{color:#8bf}</style>
      <h1 style="font-size:15px;letter-spacing:.2em;text-transform:uppercase">Take scenarios</h1>
      <p>The transfer list under states that are awkward to reach on chain, captured from the real UI.</p>
      <ul>${sheets.map((f) => `<li><a href="${f}">${f.replace(/^sheet-|\.html$/g, '')}</a></li>`).join('')}</ul>`;
    const idxFile = path.join(scnDir, 'index.html');
    fs.writeFileSync(idxFile, idx);
    sub.push(`100644 blob ${git('hash-object', '-w', idxFile)}\tindex.html`);
  }
  if (sub.length) {
    const t = execFileSync('git', ['mktree'], {cwd: ROOT, encoding: 'utf8', input: sub.join('\n') + '\n'}).trim();
    entries.push(`040000 tree ${t}\tscenarios`);
    scenarios = true;
  }
}
const tree = execFileSync('git', ['mktree'], {
  cwd: ROOT, encoding: 'utf8', input: entries.join('\n') + '\n',
}).trim();
const head = git('rev-parse', '--short', 'HEAD');
const commit = git('commit-tree', tree, '-m', `preview: ${m.page} @ ${head} (${bytes.length} B)`);
git('push', remote, `${commit}:refs/heads/gh-pages`, '--force');

const url = git('remote', 'get-url', remote);
const slug = (url.match(/github\.com[/:]([^/]+\/[^/.]+)/) || [])[1];

console.log(`published ${bytes.length.toLocaleString()} B  sha256 ${sha256.slice(0, 16)}…`);
if (slug) {
  const [owner, repo] = slug.split('/');
  const pages = `https://${owner}.github.io/${repo}/`;

  // Pages first, because it is the one that works.
  //
  // The commit-pinned githack URL was the headline here for a long time, on the
  // reasoning that a pinned path cannot serve a stale copy — which is true, and
  // was worth having after raw.githack served a build four commits old. What it
  // does instead is 429: githack rate-limits, and publishing repeatedly in one
  // session is exactly how you hit it. A link that is throttled is worse than a
  // link that might be cached.
  //
  // Pages is checked, not assumed. This script asserted for weeks that it
  // "needs Pages enabled" while Pages was serving correctly, so the caption was
  // wrong in the direction that hides the working link.
  let live = null;
  try {
    const r = await fetch(pages, {redirect: 'follow'});
    if (r.ok) {
      const body = await r.text();
      const {createHash} = await import('node:crypto');
      live = createHash('sha256').update(body).digest('hex');
    }
  } catch {}

  console.log(`\n  ${pages}`);
  if (live === sha256) console.log('  \u2514 serving this exact build (sha256 verified just now)');
  else if (live) console.log('  \u2514 Pages is up but still serving the previous build \u2014 give it a minute');
  else console.log('  \u2514 Pages did not answer \u2014 enable it on the gh-pages branch');

  if (fs.existsSync(galleryPath)) console.log(`  ${pages}gallery.html`);
  if (scenarios) console.log(`  ${pages}scenarios/`);

  console.log(`\n  https://rawcdn.githack.com/${slug}/${commit}/index.html`);
  console.log('  \u2514 commit-pinned mirror; githack rate-limits, so this 429s when leaned on');
}
