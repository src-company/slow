#!/usr/bin/env node
/**
 * Screenshot the Take view under scenarios that are hard to reach on chain:
 * a transfer three seconds from unlocking, one past its recovery window, one
 * bridged in under an address alias, a guardian mid-approval, an unreadable
 * token, an eight-figure amount.
 *
 * State is injected and then the page's OWN render path is called — makeRow,
 * renderList, renderUnlocked — so what is captured is the real UI, not a mock
 * of it. Nothing here reimplements a row.
 *
 * Usage: node scripts/scenarios.mjs [outdir]
 */
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'preview/scenarios'));
fs.mkdirSync(OUT, {recursive: true});
const {chromium} = createRequire(path.join(ROOT, 'tools/package.json'))('playwright');

// The page seals itself in an IIFE, which is right — it ships as one file into a
// contract and should export nothing. So the harness drives a COPY with a single
// line appended that hands out the few internals it needs. The copy lives in
// preview/ and is never published; dapp/page.html is untouched.
const HOOK = "window.__scn={S,setView,renderList,fmtAmt,aliasOf,ZERO};";
const src = fs.readFileSync(path.join(ROOT, 'dapp/page.html'), 'utf8');
const at = src.lastIndexOf('})();');
if (at < 0) throw new Error('could not find the IIFE close to hook into');
const harness = path.join(OUT, '_harness.html');
fs.writeFileSync(harness, src.slice(0, at) + HOOK + '\n' + src.slice(at));

const ME = '0x000000000000000000000000000000000000A11c';
const THEM = '0x000000000000000000000000000000000000bEEF';

// Every row shape the list can produce, and the awkward content that breaks it.
const SCENARIOS = {
  'outbound-mixed': {tab: 'outbound', guardian: false, rows: [
    {sym: 'USDC', dec: 6, amt: '25000000', delay: 3600, age: 3540},         // 1 min left
    {sym: 'ETH', dec: 18, amt: '1500000000000000000', delay: 86400, age: 40000},
    {sym: 'wstETH', dec: 18, amt: '12345678901234567890', delay: 604800, age: 700000}, // expired, awaiting
    {sym: 'cbBTC', dec: 8, amt: '150000000', delay: 600, age: 2600000},     // recoverable
    {sym: '???', dec: 18, amt: '1000000000000000000', delay: 3600, age: 100}, // unreadable token
  ]},
  'outbound-bridged': {tab: 'outbound', guardian: false, alias: true, rows: [
    {sym: 'ETH', dec: 18, amt: '500000000000000000', delay: 86400, age: 1000, from: 'alias'},
    {sym: 'USDC', dec: 6, amt: '1000000', delay: 86400, age: 90000, from: 'alias'},
  ]},
  'outbound-huge': {tab: 'outbound', guardian: false, rows: [
    {sym: 'SPCX', dec: 18, amt: '98765432100000000000000000', delay: 157680000, age: 10},
    {sym: 'USDT', dec: 6, amt: '1', delay: 60, age: 1},                     // one micro-unit
  ]},
  'inbound-mixed': {tab: 'inbound', guardian: false, rows: [
    {sym: 'USDC', dec: 6, amt: '4200000000', delay: 600, age: 700},         // ready
    {sym: 'ETH', dec: 18, amt: '20000000000000000', delay: 86400, age: 3600},
    {sym: 'GME', dec: 18, amt: '7000000000000000000', delay: 2592000, age: 2592100},
  ]},
  'inbound-guarded': {tab: 'inbound', guardian: true, rows: [
    {sym: 'USDC', dec: 6, amt: '4200000000', delay: 600, age: 700},
  ]},
  'unlocked': {tab: 'unlocked', guardian: true, unlocked: [
    {id: '1', token: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', symbol: 'USDC', decimals: 6, raw: '4200000000'},
    {id: '2', token: '0x0000000000000000000000000000000000000000', symbol: 'ETH', decimals: 18, raw: '250000000000000000'},
  ]},
  'empty-outbound': {tab: 'outbound', guardian: false, rows: []},
  'empty-inbound': {tab: 'inbound', guardian: false, rows: []},
};

const browser = await chromium.launch();
const shots = [];
const report = [];
for (const [name, sc] of Object.entries(SCENARIOS)) {
  for (const [vp, size] of [['desktop', {width: 1000, height: 700}], ['phone', {width: 390, height: 700}]]) {
    for (const theme of ['light', 'dark']) {
      const ctx = await browser.newContext({viewport: size, colorScheme: theme, deviceScaleFactor: 1});
      const page = await ctx.newPage();
      const errs = [];
      page.on('pageerror', (e) => errs.push(String(e)));
      await page.goto('file://' + harness);
      await page.waitForTimeout(500);
      // Switch the view FIRST and let its load settle: setView('take') starts
      // loadTransfers, which clears S.out and S.inb on its way to finding no
      // wallet. Injecting before that means injecting into state that is about
      // to be wiped — which is exactly what the first run of this script did,
      // and every shot came out as an empty list.
      await page.evaluate(() => window.__scn.setView('take'));
      await page.waitForTimeout(600);
      await page.evaluate(({sc, ME, THEM}) => {
        const {S, renderList, fmtAmt, aliasOf, ZERO} = window.__scn;
        const now = Math.floor(Date.now() / 1000);
        S.account = ME;
        S.hasGuardian = sc.guardian;
        S.loading = false;
        S.tab = sc.tab;
        const mk = (r, i) => {
          const from = r.from === 'alias' ? aliasOf(ME) : (sc.tab === 'inbound' ? THEM : ME);
          const ts = now - r.age;
          return {
            id: String(1000 + i), from, to: sc.tab === 'inbound' ? ME : THEM,
            tokenId: String(1000 + i),
            token: r.sym === 'ETH' ? ZERO : '0x' + (i + 17).toString(16).padStart(40, '0'),
            symbol: r.sym, decimals: r.dec,
            amountRaw: BigInt(r.amt), amount: fmtAmt(BigInt(r.amt), r.dec),
            timestamp: ts, delay: r.delay, unlockTime: ts + r.delay,
          };
        };
        const rows = (sc.rows || []).map(mk);
        S.out = sc.tab === 'outbound' ? rows : [];
        S.inb = sc.tab === 'inbound' ? rows : [];
        S.unlocked = (sc.unlocked || []).map((u) => ({...u, raw: BigInt(u.raw), amount: fmtAmt(BigInt(u.raw), u.decimals)}));
        renderList();
      }, {sc, ME, THEM});
      await page.waitForTimeout(400);
      if (vp === 'desktop' && theme === 'dark') {
        const audit = await page.evaluate(() => {
          const rows = [...document.querySelectorAll('.tx')].map((r) => {
            const amt = r.querySelector('.tx-amt'), party = r.querySelector('.tx-party');
            const st = r.querySelector('.tx-status'), act = r.querySelector('.tx-act');
            const clipped = (e) => e && e.scrollWidth > e.clientWidth + 1;
            return {
              amount: amt && amt.textContent, party: party && party.textContent,
              status: st && st.textContent, action: act && act.textContent.trim(),
              overflow: [amt, party, st].filter(clipped).map((e) => e.className),
            };
          });
          const empty = document.querySelector('.list .empty');
          const box = document.querySelector('.list');
          return {rows, empty: empty && empty.textContent.trim(),
                  hscroll: box ? box.scrollWidth > box.clientWidth + 1 : false};
        });
        report.push({scenario: name, ...audit});
      }
      const file = `${name}-${vp}-${theme}.png`;
      await page.screenshot({path: path.join(OUT, file), clip: {x: 0, y: 0, width: size.width, height: size.height}});
      shots.push(file);
      if (errs.length) console.error(`[${name}/${vp}/${theme}] ${errs.slice(0, 3).join(' | ')}`);
      await ctx.close();
    }
  }
}
await browser.close();

// A contact sheet, so a whole variant is one look rather than thirty-two.
for (const theme of ['light', 'dark']) {
  for (const vp of ['desktop', 'phone']) {
    const set = shots.filter((f) => f.endsWith(`-${vp}-${theme}.png`));
    const html = `<style>body{margin:0;background:${theme === 'dark' ? '#222' : '#bbb'};
      display:grid;grid-template-columns:repeat(${vp === 'phone' ? 4 : 2},1fr);gap:10px;padding:10px;
      font:11px system-ui;color:${theme === 'dark' ? '#fff' : '#000'}}
      figure{margin:0}img{width:100%;display:block;border:1px solid #666}
      figcaption{padding:4px 0}</style>` +
      set.map((f) => `<figure><img src="${f}"><figcaption>${f.replace(`-${vp}-${theme}.png`, '')}</figcaption></figure>`).join('');
    fs.writeFileSync(path.join(OUT, `sheet-${vp}-${theme}.html`), html);
  }
}
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1));
let problems = 0;
for (const s of report) {
  console.log(`\n── ${s.scenario}${s.hscroll ? '   ⚠ THE LIST SCROLLS SIDEWAYS' : ''}`);
  if (s.hscroll) problems++;
  if (s.empty) console.log(`   (empty) ${s.empty.replace(/\s+/g, ' ')}`);
  for (const r of s.rows) {
    const bad = r.overflow.length ? `  ⚠ clipped: ${r.overflow.join(', ')}` : '';
    if (r.overflow.length) problems++;
    console.log(`   ${(r.amount || '').padEnd(26)} ${(r.party || '').padEnd(10)} ` +
      `${(r.status || '').padEnd(44)} [${r.action || '—'}]${bad}`);
  }
}
console.log(`\n${shots.length} scenario shots -> ${OUT}`);
console.log(problems ? `${problems} layout problems found` : 'no clipping, no sideways scroll');

// A text report beside the pixels. Not a substitute for looking — it cannot see
// that something is ugly — but it catches the things looking is bad at:
// a row that overflows its box, an action offered where it cannot succeed, a
// status that says nothing, an amount that lost its precision.
