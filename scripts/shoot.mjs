#!/usr/bin/env node
/**
 * Render the page and the ERC-1155 art to PNG, so design decisions are made by
 * looking rather than by reasoning about CSS.
 *
 * The page is opened from the file system and driven through its own UI — the
 * views are behind classes on <body> and the flows behind real clicks, so
 * anything reached by faking state would not be the thing a reader sees.
 *
 * Usage: node scripts/shoot.mjs [outdir]
 */
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';

// Playwright lives in tools/, not the repo root: nothing that SHIPS needs npm,
// and a root package.json would suggest otherwise. Setup, once:
//   cd tools && npm i && npx playwright install --with-deps chromium
const ROOT = path.resolve(import.meta.dirname, '..');
let chromium;
try {
  chromium = createRequire(path.join(ROOT, 'tools/package.json'))('playwright').chromium;
} catch (e) {
  console.error('Playwright is not installed. Run:\n  cd tools && npm i && npx playwright install --with-deps chromium');
  process.exit(1);
}

const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'preview/shots'));
fs.mkdirSync(OUT, {recursive: true});

const PAGE = 'file://' + path.join(ROOT, 'dapp/page.html');
const VIEWPORTS = {
  desktop: {width: 1280, height: 860},
  tablet: {width: 820, height: 1100},
  phone: {width: 390, height: 844},
  narrow: {width: 320, height: 780},
};

const browser = await chromium.launch();
const shots = [];

async function shoot(page, name) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({path: file});
  shots.push(name);
}

for (const [vp, size] of Object.entries(VIEWPORTS)) {
  for (const theme of ['light', 'dark']) {
    const ctx = await browser.newContext({viewport: size, colorScheme: theme, deviceScaleFactor: 2});
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
    await page.goto(PAGE);
    await page.waitForTimeout(700);

    await shoot(page, `${vp}-${theme}-home`);

    // Into the send flow, by clicking what a reader clicks.
    await page.click('#sendBox').catch(() => {});
    await page.waitForTimeout(400);
    await shoot(page, `${vp}-${theme}-send`);

    // A filled-in form: pick a token, type a recipient and an amount.
    await page.fill('#recipientInput', 'vitalik.eth').catch(() => {});
    await page.click('.crypto[data-token]:nth-of-type(2)').catch(() => {});
    await page.fill('#amountInput', '25').catch(() => {});
    // A delay too, so the on-chain preview has something to draw.
    await page.click('#timeRow [data-time="86400"]').catch(() => {});
    await page.waitForTimeout(900);
    await shoot(page, `${vp}-${theme}-send-filled`);

    // The take view and the guardian view.
    await page.click('#homeBtn').catch(() => {});
    await page.waitForTimeout(250);
    await page.click('#takeBox').catch(() => {});
    await page.waitForTimeout(600);
    await shoot(page, `${vp}-${theme}-take`);

    // Modals, which is where the type and spacing show worst.
    await page.click('#helpBtn').catch(() => {});
    await page.waitForTimeout(300);
    await shoot(page, `${vp}-${theme}-help`);
    await page.keyboard.press('Escape').catch(() => {});
    await page.click('#chainBtn').catch(() => {});
    await page.waitForTimeout(300);
    await shoot(page, `${vp}-${theme}-chains`);

    if (errs.length) console.error(`[${vp}/${theme}] page errors:\n  ` + errs.slice(0, 6).join('\n  '));
    await ctx.close();
  }
}

// The renders, as a contact sheet at wallet-list size and one at full size.
const tsv = path.join(ROOT, 'preview/gallery.tsv');
if (fs.existsSync(tsv)) {
  const rows = fs.readFileSync(tsv, 'utf8').trim().split('\n');
  const dec = (u) => Buffer.from(u.split(',')[1], 'base64').toString('utf8');
  const items = rows.map((r) => {
    const [symbol, delay, uri] = r.split('\t');
    return {symbol, delay, svg: dec(JSON.parse(dec(uri)).image)};
  });
  const ctx = await browser.newContext({deviceScaleFactor: 2});
  const page = await ctx.newPage();

  // One at 600px: the marketplace view, where the composition has to hold.
  await page.setViewportSize({width: 600, height: 600});
  await page.setContent(`<style>body{margin:0}svg{width:600px;height:600px;display:block}</style>${items[20].svg}`);
  await shoot(page, 'nft-600-usdt');
  await page.setContent(`<style>body{margin:0}svg{width:600px;height:600px;display:block}</style>${items[0].svg}`);
  await shoot(page, 'nft-600-eth');
  await page.setContent(`<style>body{margin:0}svg{width:600px;height:600px;display:block}</style>${items[items.length - 1].svg}`);
  await shoot(page, 'nft-600-extreme');

  // A contact sheet at 120px: the wallet-list view, where legibility is decided.
  const sheet = items.filter((_, i) => i % 3 === 0).slice(0, 24);
  await page.setViewportSize({width: 1000, height: 1000});
  await page.setContent(`<style>body{margin:0;background:#888;display:grid;
    grid-template-columns:repeat(6,120px);gap:12px;padding:12px}
    div{width:120px;height:120px}svg{width:120px;height:120px;display:block}</style>` +
    sheet.map((i) => `<div>${i.svg}</div>`).join(''));
  await page.waitForTimeout(200);
  await shoot(page, 'nft-120-sheet');
  await ctx.close();
}

await browser.close();
console.log(`${shots.length} shots -> ${OUT}`);
