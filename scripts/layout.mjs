#!/usr/bin/env node
/**
 * Measure the send form instead of squinting at it.
 *
 * Screenshots show you a layout is wrong; they do not tell you by how much, and
 * "looks a bit unbalanced" is not something you can fix or regress against.
 * This drives the real page and reports the numbers that decide whether the
 * form works: where the primary action lands, how much sits below the fold,
 * how far apart the two columns end, and whether anything overflows sideways.
 *
 * It found the two defects screenshots did not: the Send button 412px below the
 * fold on a laptop, and a countdown reading "1824d 23h 59m".
 *
 * Usage: node scripts/layout.mjs
 */
import path from 'node:path';
import {createRequire} from 'node:module';

const ROOT = path.resolve(import.meta.dirname, '..');
const {chromium} = createRequire(path.join(ROOT, 'tools/package.json'))('playwright');

const VIEWS = [['desktop', 1440, 900], ['laptop', 1280, 800], ['phone', 390, 844], ['narrow', 320, 780]];
const browser = await chromium.launch();
let problems = 0;

for (const [name, width, height] of VIEWS) {
  const ctx = await browser.newContext({viewport: {width, height}, colorScheme: 'dark'});
  const page = await ctx.newPage();
  await page.goto('file://' + path.join(ROOT, 'dapp/page.html'));
  await page.waitForTimeout(500);
  await page.click('#sendBox').catch(() => {});
  await page.waitForTimeout(250);
  await page.fill('#recipientInput', 'vitalik.eth').catch(() => {});
  await page.click('.crypto[data-token]:nth-of-type(2)').catch(() => {});
  await page.fill('#amountInput', '25').catch(() => {});
  await page.click('#timeRow [data-time="86400"]').catch(() => {});
  await page.waitForTimeout(1400);

  const r = await page.evaluate((w) => {
    const box = (s) => {
      const e = document.querySelector(s);
      if (!e || e.hidden || !e.getBoundingClientRect().height) return null;
      const b = e.getBoundingClientRect();
      return {t: Math.round(b.top), b: Math.round(b.bottom), w: Math.round(b.width), h: Math.round(b.height)};
    };
    const pane = document.querySelector('.sendPane');
    const clipped = [...document.querySelectorAll('.sendPane *')]
      .filter((e) => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX !== 'auto')
      .map((e) => e.id || e.className).slice(0, 6);
    const btn = document.querySelector('#confirmBtn');
    return {
      confirm: box('#confirmBtn'), colA: box('#colA'), colB: box('#colB'),
      // Whether the button scrolls with the form or sits in fixed chrome
      // decides what "below the fold" even means for it. Measuring it against
      // the pane when it lives outside the pane is how this probe first
      // reported Send off-screen on a viewport where it was plainly visible.
      inPane: !!(btn && pane && pane.contains(btn)),
      paneH: pane ? pane.scrollHeight : 0, viewH: pane ? pane.clientHeight : 0,
      windowH: window.innerHeight,
      docW: document.documentElement.scrollWidth, w, clipped,
    };
  }, width);

  const below = Math.max(0, r.paneH - r.viewH);
  const ragged = r.colA && r.colB ? Math.abs(r.colA.b - r.colB.b) : 0;
  // Against the window, not the pane: the button is only unreachable if it is
  // off the SCREEN, and if it is not in the scrolling pane it never moves.
  const confirmBelow = r.confirm ? Math.max(0, r.confirm.b - r.windowH) : null;
  const hOverflow = r.docW > width + 1;

  console.log(`\n── ${name} ${width}×${height}`);
  console.log(`   content ${r.paneH}px in ${r.viewH}px` + (below ? `  → ${below}px below the fold` : '  → fits'));
  if (r.confirm) {
    console.log(`   Send at y ${r.confirm.t}–${r.confirm.b} (${r.confirm.w}px wide, ` +
      `${r.inPane ? 'scrolls with the form' : 'fixed chrome'})` +
      (confirmBelow ? `  ⚠ ${confirmBelow}px BELOW THE SCREEN` : '  ✓ on screen'));
    if (confirmBelow) problems++;
  } else console.log('   Send: not rendered');
  if (ragged) console.log(`   columns end ${ragged}px apart`);
  if (hOverflow) { console.log(`   ⚠ HORIZONTAL OVERFLOW ${r.docW} > ${width}`); problems++; }
  if (r.clipped.length) { console.log(`   ⚠ clipped: ${r.clipped.join(', ')}`); problems++; }
  await ctx.close();
}

await browser.close();
console.log(problems ? `\n${problems} layout problems` : '\nno layout problems');
process.exit(problems ? 1 : 0);
