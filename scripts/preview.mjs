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
const commit = git('commit-tree', tree, '-m', `preview: ${m.page} @ ${head} (${bytes.length} B)`);
git('push', remote, `${commit}:refs/heads/gh-pages`, '--force');

const url = git('remote', 'get-url', remote);
const slug = (url.match(/github\.com[/:]([^/]+\/[^/.]+)/) || [])[1];

console.log(`published ${bytes.length.toLocaleString()} B  sha256 ${sha256.slice(0, 16)}…`);
if (slug) {
  // Pin the URL to the commit, not the branch.
  //
  // raw.githack.com bills itself as the uncached endpoint and is not: it served
  // a build four commits old while the branch was correct, which looks exactly
  // like a change that did not ship. A commit-pinned rawcdn path is immutable,
  // so it cannot go stale — at the cost of a new URL per publish, which is the
  // right trade while iterating.
  console.log(`\n  https://rawcdn.githack.com/${slug}/${commit}/index.html`);
  console.log(`  \u2514 pinned to this commit, cannot serve a stale copy`);
  const [owner, repo] = slug.split('/');
  console.log(`\n  https://${owner}.github.io/${repo}/`);
  console.log(`  \u2514 stable URL, updates on push \u2014 needs Pages enabled on gh-pages`);
}
