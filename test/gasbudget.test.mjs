/**
 * The gas budgets `test/ArrivalGas.t.sol` measures against are a CLAIM about
 * `dapp/page.html`, and a Solidity test cannot read the page. So the claim is
 * checked here instead.
 *
 * Without this the two drift silently in the worst direction: raise the page's
 * `l2GasLimit` — which the runbook recommends, because a contract recipient
 * past ~5 cold writes currently loses a bridged send — and the gas test carries
 * on asserting against the old number, passing while measuring nothing real.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const page = fs.readFileSync(path.join(ROOT, 'dapp/page.html'), 'utf8');
const gasTest = fs.readFileSync(path.join(ROOT, 'test/ArrivalGas.t.sol'), 'utf8');

/** `l2GasLimit` per destination chain, read out of the page's BRIDGES table. */
const pageBudgets = () => {
  const bridges = /const BRIDGES = \{([\s\S]*?)\n\};/.exec(page)?.[1];
  assert.ok(bridges, 'BRIDGES table not found in the page');
  const out = {};
  for (const m of bridges.matchAll(/(\d+):\s*\{[\s\S]*?l2GasLimit:\s*([\d_]+)n/g)) {
    out[Number(m[1])] = Number(m[2].replace(/_/g, ''));
  }
  return out;
};

const solConst = (name) => {
  const m = new RegExp(`constant ${name} = ([\\d_]+)`).exec(gasTest);
  assert.ok(m, `${name} not found in ArrivalGas.t.sol`);
  return Number(m[1].replace(/_/g, ''));
};

test('the gas test measures against what the page actually buys', () => {
  const budgets = pageBudgets();
  assert.equal(budgets[8453], solConst('BASE_BUDGET'),
    'Base: the page and the gas test disagree about the destination gas bought');
  assert.equal(budgets[4663], solConst('ROBINHOOD_BUDGET'),
    'Robinhood: the page and the gas test disagree about the destination gas bought');
});

test('every bridged destination has a budget the gas test knows about', () => {
  const budgets = pageBudgets();
  assert.deepEqual(Object.keys(budgets).map(Number).sort(), [4663, 8453],
    'a new bridge destination needs a budget in ArrivalGas.t.sol too');
});
