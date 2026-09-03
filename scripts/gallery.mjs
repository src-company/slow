#!/usr/bin/env node
/**
 * Build the render gallery from out/gallery.tsv — the raw uri() output of a
 * deployed SLOWNext, produced by script/RenderGallery.s.sol.
 *
 * The point of going through the contract rather than porting the renderer to
 * JS is that a port can be wrong in exactly the way that matters: it would show
 * a picture nobody's wallet will ever draw. What is below is the bytes a holder
 * gets.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const rows = fs.readFileSync(path.join(ROOT, 'preview/gallery.tsv'), 'utf8').trim().split('\n');

const b64 = (s) => Buffer.from(s, 'base64').toString('utf8');
const items = rows.map((line) => {
  const [symbol, delay, uri] = line.split('\t');
  const meta = JSON.parse(uri.startsWith('data:application/json;base64,')
    ? b64(uri.slice('data:application/json;base64,'.length))
    : decodeURIComponent(uri.replace(/^data:application\/json(;utf8)?,/, '')));
  const img = meta.image.startsWith('data:image/svg+xml;base64,')
    ? b64(meta.image.slice('data:image/svg+xml;base64,'.length))
    : decodeURIComponent(meta.image.replace(/^data:image\/svg\+xml(;utf8)?,/, ''));
  // Kept as a string: the ceiling delay is uint96, which Number() turns into
  // 7.9e+28 and every downstream comparison then misses.
  return {symbol, delay, name: meta.name, svg: img, bytes: meta.image.length};
});

const SYMBOLS = [...new Set(items.map((i) => i.symbol))];
const DELAYS = [...new Set(items.map((i) => i.delay))].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
const label = (d) => items.find((i) => i.delay === d).name.split('·').pop().trim();

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const cards = items.map((i) => `<figure class="c" data-sym="${i.symbol}" data-delay="${i.delay}">
  <div class="art">${i.svg}</div>
  <figcaption><b>${esc(i.name)}</b><span>${i.bytes.toLocaleString()} B on chain</span></figcaption>
</figure>`).join('\n');

const html = `<title>SLOW Render Gallery</title>
<style>
:root{--bg:#fff;--fg:#000;--bg2:#f4f4f4;--bd:#d4d4d4;--dim:#5a5a5a}
:root:not([data-theme=light]) , :root[data-theme=dark]{}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#0b0b0b;--fg:#fff;--bg2:#161616;--bd:#2c2c2c;--dim:#9a9a9a}}
:root[data-theme=dark]{--bg:#0b0b0b;--fg:#fff;--bg2:#161616;--bd:#2c2c2c;--dim:#9a9a9a}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--fg);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:28px 20px 60px}
header{max-width:1180px;margin:0 auto 26px}
h1{font-size:15px;font-weight:700;letter-spacing:.22em;text-transform:uppercase}
p.sub{color:var(--dim);margin-top:8px;max-width:62ch}
.bar{max-width:1180px;margin:0 auto 20px;display:flex;flex-wrap:wrap;gap:6px}
.bar button{font:inherit;font-size:12px;padding:7px 12px;min-height:38px;background:transparent;color:var(--fg);border:1px solid var(--bd);cursor:pointer}
.bar button[aria-pressed=true]{background:var(--fg);color:var(--bg);border-color:var(--fg)}
.bar .sp{flex-basis:100%;height:0}
.grid{max-width:1180px;margin:0 auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:14px}
.c{border:1px solid var(--bd);background:var(--bg2);display:flex;flex-direction:column}
.c[hidden]{display:none}
.art{aspect-ratio:1/1;display:flex;align-items:center;justify-content:center;overflow:hidden;background:var(--bg)}
.art svg{width:100%;height:100%;display:block}
figcaption{padding:10px 12px;border-top:1px solid var(--bd);display:flex;flex-direction:column;gap:3px;font-size:12px}
figcaption b{font-weight:600;overflow-wrap:anywhere}
figcaption span{color:var(--dim);font-size:11px;font-variant-numeric:tabular-nums}
@media (max-width:520px){.grid{grid-template-columns:repeat(auto-fill,minmax(150px,1fr))}}
</style>
<header>
  <h1>SLOW &middot; Render Gallery</h1>
  <p class="sub">Every image below is the literal output of <code>uri(id)</code> on a deployed SLOWNext &mdash;
  compiled, run in the EVM, and decoded here. Nothing is re-drawn. ${items.length} renders:
  ${SYMBOLS.length} assets &times; ${DELAYS.length} delays, from one minute to the <code>uint96</code> ceiling.</p>
</header>
<div class="bar" id="bar">
  <button data-f="sym" data-v="" aria-pressed="true">All assets</button>
  ${SYMBOLS.map((s) => `<button data-f="sym" data-v="${s}" aria-pressed="false">${s}</button>`).join('')}
  <span class="sp"></span>
  <button data-f="delay" data-v="" aria-pressed="true">All delays</button>
  ${DELAYS.map((d) => `<button data-f="delay" data-v="${d}" aria-pressed="false">${esc(label(d))}</button>`).join('')}
</div>
<div class="grid">
${cards}
</div>
<script>
const f = {sym: '', delay: ''};
const apply = () => {
  for (const c of document.querySelectorAll('.c')) {
    c.hidden = (f.sym && c.dataset.sym !== f.sym) || (f.delay && c.dataset.delay !== f.delay);
  }
};
document.getElementById('bar').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  f[b.dataset.f] = b.dataset.v;
  for (const o of document.querySelectorAll('[data-f="' + b.dataset.f + '"]')) {
    o.setAttribute('aria-pressed', String(o === b));
  }
  apply();
});
</script>`;

fs.writeFileSync(path.join(ROOT, 'preview/gallery.html'), html);
const total = items.reduce((a, i) => a + i.bytes, 0);
console.log(`${items.length} renders · largest ${Math.max(...items.map((i) => i.bytes)).toLocaleString()} B` +
  ` · mean ${Math.round(total / items.length).toLocaleString()} B`);
