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
import {ROOT, loadManifest, readPage} from './lib.mjs';

const git = (...a) => execFileSync('git', a, {cwd: ROOT, encoding: 'utf8'}).trim();
const remote = process.argv[2] || 'origin';

const m = loadManifest();
const {bytes, sha256} = readPage(m);

const blob = git('hash-object', '-w', path.join(ROOT, m.page));
const nojekyll = execFileSync('git', ['hash-object', '-w', '--stdin'], {cwd: ROOT, input: '', encoding: 'utf8'}).trim();
const tree = execFileSync('git', ['mktree'], {
  cwd: ROOT, encoding: 'utf8',
  input: `100644 blob ${blob}\tindex.html\n100644 blob ${nojekyll}\t.nojekyll\n`,
}).trim();
const head = git('rev-parse', '--short', 'HEAD');
const commit = git('commit-tree', tree, '-m', `preview: ${m.page} @ ${head} (${bytes} B)`);
git('push', remote, `${commit}:refs/heads/gh-pages`, '--force');

const url = git('remote', 'get-url', remote);
const slug = (url.match(/github\.com[/:]([^/]+\/[^/.]+)/) || [])[1];

console.log(`published ${bytes.toLocaleString()} B  sha256 ${sha256.slice(0, 16)}…`);
if (slug) {
  console.log(`\n  https://raw.githack.com/${slug}/gh-pages/index.html   (uncached — reflects each push)`);
  console.log(`  https://${slug.split('/')[0]}.github.io/${slug.split('/')[1]}/   (once Pages is enabled on gh-pages)`);
}
