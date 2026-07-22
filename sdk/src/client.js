// client.js — framework-agnostic SLOW client over any EIP-1193 provider.
//
// Works with `window.ethereum`, a WalletConnect provider, viem's
// `EIP1193Provider`, ethers `provider.provider`, or a bare JSON-RPC shim
// exposing `request({ method, params })`. Zero dependencies.
//
//   import { SlowClient } from './sdk/src/client.js';
//   const slow = new SlowClient(window.ethereum);
//   await slow.deposit({ token: 'ETH', to, amount: '0.1', delay: '1d' });
//
// Read-only usage needs only an RPC transport; writes need a signer account.

import {
  encodeCall, decode, encodeId, decodeId, parseUnits, formatUnits,
  keccak256, padL, ZERO_ADDRESS, isAddress,
} from './codec.js';
import {
  SLOW_ADDRESS, MAINNET_CHAIN_ID, SEL, EVENTS, TOKENS, DELAYS, ETH,
  CLAWBACK_GRACE, GUARDIAN_CHANGE_DELAY, errorName,
} from './abi.js';
import { resolveName, reverseName, isName } from './names.js';

const bn = v => (typeof v === 'bigint' ? v : BigInt(v));
const hex = v => '0x' + bn(v).toString(16);

/** Resolve a token shorthand ("ETH"/"USDC"/…) or an address to `{ address, decimals }`. */
function resolveToken(token) {
  if (token == null || token === 'ETH') return { address: ETH, decimals: 18 };
  if (typeof token === 'string' && TOKENS[token]) return TOKENS[token];
  if (isAddress(token)) return { address: token, decimals: null };
  if (token && isAddress(token.address)) return { address: token.address, decimals: token.decimals ?? null };
  throw new Error('Unknown token: ' + JSON.stringify(token));
}

/** Resolve a delay shorthand ("1d") or seconds number/bigint to a seconds Number. */
function resolveDelay(delay) {
  if (delay == null) return 0;
  if (typeof delay === 'string' && delay in DELAYS) return DELAYS[delay];
  return Number(delay);
}

export class SlowClient {
  /**
   * @param {{request: Function}} provider - an EIP-1193 provider.
   * @param {object} [opts]
   * @param {string} [opts.address] - override the SLOW contract address (e.g. a fork).
   * @param {string} [opts.account] - default `from` for writes; else read from the provider.
   * @param {number} [opts.chainId] - expected chain (default mainnet); writes assert it.
   */
  constructor(provider, opts = {}) {
    if (!provider || typeof provider.request !== 'function') {
      throw new Error('SlowClient needs an EIP-1193 provider with a request() method');
    }
    this.provider = provider;
    this.address = opts.address || SLOW_ADDRESS;
    this.account = opts.account || null;
    this.chainId = opts.chainId ?? MAINNET_CHAIN_ID;
    this.mode = opts.mode || 'send'; // 'send' submits; 'prepare' returns the unsigned tx request
    this._gate = null;
    this._decimals = new Map(); // token -> decimals cache
  }

  // -- transport ------------------------------------------------------------

  request(method, params) { return this.provider.request({ method, params }); }

  /** Raw `eth_call` to a target (defaults to SLOW), returns hex return data. */
  call(data, to = this.address) {
    return this.request('eth_call', [{ to, data }, 'latest']);
  }

  async _from() {
    if (this.account) return this.account;
    const [a] = await this.request('eth_accounts', []);
    if (!a) throw new Error('No connected account; call requestAccounts() first');
    this.account = a;
    return a;
  }

  /** Prompt the wallet to connect and cache the first account. */
  async requestAccounts() {
    const [a] = await this.request('eth_requestAccounts', []);
    this.account = a;
    return a;
  }

  async assertChain() {
    const id = parseInt(await this.request('eth_chainId', []), 16);
    if (id !== this.chainId) throw new Error(`Wrong network: connected to ${id}, expected ${this.chainId}`);
  }

  /**
   * Send a transaction to SLOW (or `to`) and return the tx hash.
   *
   * In `mode: 'prepare'` (set on the client), this does NOT submit — it returns
   * the transaction request `{ from, to, data, value, chainId }` for an external
   * signer (a wallet, a multisig, a review step, an agent's own tooling). This
   * is the safe default for autonomous agents: build, inspect, then sign.
   */
  async send(data, { value = 0n, to = this.address } = {}) {
    const tx = { to, data };
    if (bn(value) !== 0n) tx.value = hex(value);
    if (this.mode === 'prepare') {
      if (this.account) tx.from = this.account;
      return { ...tx, chainId: this.chainId };
    }
    await this.assertChain();
    tx.from = await this._from();
    return this.request('eth_sendTransaction', [tx]);
  }

  /** Poll for a receipt. Throws on revert. */
  async wait(hash, { timeoutMs = 600000, pollMs = 2000 } = {}) {
    const end = _now() + timeoutMs;
    while (_now() < end) {
      const r = await this.request('eth_getTransactionReceipt', [hash]);
      if (r) {
        if (r.status !== '0x1') throw new Error('Transaction reverted: ' + hash);
        return r;
      }
      await sleep(pollMs);
    }
    throw new Error('Confirmation timed out: ' + hash);
  }

  // -- id + units helpers (re-exported as methods for convenience) ----------

  encodeId(token, delay) { return encodeId(resolveToken(token).address, resolveDelay(delay)); }
  decodeId(id) { return decodeId(id); }

  // -- name resolution (ENS + WNS .wei) -------------------------------------

  /** Resolve an ENS/`.wei` name to an address (null if unresolved). */
  resolveName(name) { return resolveName(this, name); }

  /** Reverse-resolve an address to a name, preferring `.wei` (WNS) then ENS. */
  reverseName(addr) { return reverseName(this, addr); }

  /**
   * Accept an address or a name and return a checksum-free address.
   * Throws if a name does not resolve. Addresses pass through untouched.
   */
  async resolveRecipient(to) {
    if (isAddress(to)) return to;
    if (isName(to)) {
      const a = await this.resolveName(to);
      if (!a) throw new Error(`Could not resolve name: ${to}`);
      return a;
    }
    throw new Error('Invalid recipient (not an address or resolvable name): ' + to);
  }

  async decimalsOf(token) {
    const { address, decimals } = resolveToken(token);
    if (decimals != null) return decimals;
    if (address === ETH) return 18;
    if (this._decimals.has(address)) return this._decimals.get(address);
    const ret = await this.call(SEL.erc20decimals, address);
    const d = ret && ret !== '0x' ? Number(BigInt(ret)) : 18;
    this._decimals.set(address, d);
    return d;
  }

  // -- reads ----------------------------------------------------------------

  /** Full wrapper balance for `id` (includes amounts still pending). */
  async balanceOf(owner, id) {
    return BigInt(await this.call(encodeCall(SEL.balanceOf, ['address', 'uint256'], [owner, bn(id)])));
  }

  /** Spendable balance for `id` — the source of truth for what can leave. */
  async unlockedBalanceOf(owner, id) {
    return BigInt(await this.call(encodeCall(SEL.unlockedBalances, ['address', 'uint256'], [owner, bn(id)])));
  }

  /** The SLOWGate operator address (cached). Approve it to enable keeper settlement. */
  async gate() {
    if (this._gate) return this._gate;
    const ret = await this.call(SEL.gate);
    this._gate = '0x' + ret.slice(-40);
    return this._gate;
  }

  async guardianOf(user) {
    const ret = await this.call(encodeCall(SEL.guardians, ['address'], [user]));
    return '0x' + ret.slice(-40);
  }

  async isApprovedForAll(owner, operator) {
    const ret = await this.call(encodeCall(SEL.isApprovedForAll, ['address', 'address'], [owner, operator]));
    return BigInt(ret) === 1n;
  }

  /** Decode a pending transfer. Returns null if it does not exist. */
  async getPendingTransfer(transferId) {
    const ret = await this.call(encodeCall(SEL.pendingTransfers, ['uint256'], [bn(transferId)]));
    const [timestamp, from, to, id, amount] = decode(['uint256', 'address', 'address', 'uint256', 'uint256'], ret);
    if (timestamp === 0n) return null;
    const { token, delay } = decodeId(id);
    const created = Number(timestamp);
    const expiry = created + delay;
    return {
      transferId: bn(transferId), timestamp: created, from, to, id, amount, token, delay,
      expiry, clawbackAt: expiry + CLAWBACK_GRACE,
    };
  }

  /** Enrich a pending transfer with lifecycle flags at a given wall-clock (seconds). */
  async pendingStatus(transferId, now = Math.floor(_now() / 1000)) {
    const pt = await this.getPendingTransfer(transferId);
    if (!pt) return null;
    return {
      ...pt,
      pending: now < pt.expiry,               // still in the timelock
      reversible: now < pt.expiry,            // sender can reverse()
      settleable: now >= pt.expiry,           // recipient/operator can unlock()/claim()
      clawbackReady: now >= pt.clawbackAt,    // sender can clawback()
      secondsUntilExpiry: Math.max(0, pt.expiry - now),
    };
  }

  async getInboundTransfers(user) {
    return decode(['uint256[]'], await this.call(encodeCall(SEL.getInboundTransfers, ['address'], [user])))[0];
  }
  async getOutboundTransfers(user) {
    return decode(['uint256[]'], await this.call(encodeCall(SEL.getOutboundTransfers, ['address'], [user])))[0];
  }

  /** canReverseTransfer -> { canReverse, reason } with reason decoded to a name. */
  async canReverse(transferId) {
    const ret = await this.call(encodeCall(SEL.canReverseTransfer, ['uint256'], [bn(transferId)]));
    const can = BigInt('0x' + ret.slice(2, 66)) === 1n;
    const reason = '0x' + ret.slice(66, 74);
    return { canReverse: can, reason: errorName(can ? '0x' : reason) };
  }

  async isGuardianApprovalNeeded(user, to, id, amount) {
    const ret = await this.call(encodeCall(SEL.isGuardianApprovalNeeded, ['address', 'address', 'uint256', 'uint256'], [user, to, bn(id), bn(amount)]));
    return BigInt(ret) === 1n;
  }

  /** Read the on-chain SVG data-URI for a token id (for wallet/marketplace display). */
  async uri(id) {
    return decode(['string'], await this.call(encodeCall(SEL.uri, ['uint256'], [bn(id)])))[0];
  }

  // -- ERC-20 approval (needed before an ERC-20 deposit) --------------------

  async erc20Allowance(token, owner) {
    const { address } = resolveToken(token);
    if (address === ETH) return (1n << 256n) - 1n;
    const ret = await this.call(encodeCall(SEL.erc20allowance, ['address', 'address'], [owner, this.address]), address);
    return BigInt(ret);
  }

  /** Approve the SLOW wrapper to pull `amount` of an ERC-20 (max if amount omitted). */
  async approveErc20(token, amount) {
    const { address } = resolveToken(token);
    if (address === ETH) throw new Error('ETH does not require approval');
    const a = amount == null ? (1n << 256n) - 1n : bn(amount);
    return this.send(encodeCall(SEL.erc20approve, ['address', 'uint256'], [this.address, a]), { to: address });
  }

  // -- writes: deposit ------------------------------------------------------

  /**
   * Wrap and send. For ETH, `token` omitted/"ETH"; value is taken from `amount`.
   * For ERC-20, ensure `approveErc20` first.
   * @param {object} o
   * @param {string} o.to - recipient.
   * @param {string|bigint} o.amount - human units ("0.1") or base units (bigint).
   * @param {string|number} [o.token] - "ETH" | symbol | address. Default ETH.
   * @param {string|number} [o.delay] - "1d" | seconds. Default 0 (instant, no timelock).
   * @param {bigint|string} [o.tip] - optional relayer tip (ETH base units); routes through depositToWithTip.
   * @param {string} [o.data] - ERC-1155 onReceived data (default 0x).
   * @returns {Promise<string>} tx hash.
   */
  async deposit({ to, amount, token = 'ETH', delay = 0, tip = 0n, data = '0x' }) {
    to = await this.resolveRecipient(to); // accepts 0x…, ENS, or .wei
    const t = resolveToken(token);
    const dec = t.decimals ?? await this.decimalsOf(t.address);
    const amt = typeof amount === 'bigint' ? amount : parseUnits(amount, dec);
    const del = resolveDelay(delay);
    const isEth = t.address === ETH;
    const tipWei = bn(tip);

    if (tipWei > 0n) {
      if (del === 0) throw new Error('deposit: tip requires a delay > 0');
      const value = isEth ? amt + tipWei : tipWei;
      const cd = encodeCall(SEL.depositToWithTip,
        ['address', 'address', 'uint256', 'uint96', 'uint256', 'bytes'],
        [isEth ? ETH : t.address, to, amt, del, tipWei, data]);
      return this.send(cd, { value });
    }

    // For ETH, the contract requires token==0 && amount==0 and reads msg.value.
    const cd = encodeCall(SEL.depositTo,
      ['address', 'address', 'uint256', 'uint96', 'bytes'],
      [isEth ? ETH : t.address, to, isEth ? 0n : amt, del, data]);
    return this.send(cd, { value: isEth ? amt : 0n });
  }

  // -- writes: settle / recover --------------------------------------------

  /** Recipient (or operator) settles a matured transfer into unlockedBalance. */
  unlock(transferId) {
    return this.send(encodeCall(SEL.unlock, ['uint256'], [bn(transferId)]));
  }
  /** Settle via the recipient's own claim (recipient must have approved the gate for gate.claim). */
  claim(transferId) {
    return this.send(encodeCall(SEL.claim, ['uint256'], [bn(transferId)]));
  }
  /** Sender cancels a pending transfer before expiry. */
  reverse(transferId) {
    return this.send(encodeCall(SEL.reverse, ['uint256'], [bn(transferId)]));
  }
  /** Sender recovers a never-settled transfer 30 days past expiry. */
  clawback(transferId) {
    return this.send(encodeCall(SEL.clawback, ['uint256'], [bn(transferId)]));
  }

  // -- writes: withdraw / transfer -----------------------------------------

  /** Unwrap `amount` of `id` from `from` to `to` (draws from unlockedBalance). `to` may be a name. */
  async withdraw({ from, to, id, amount }) {
    to = await this.resolveRecipient(to);
    return this.send(encodeCall(SEL.withdrawFrom, ['address', 'address', 'uint256', 'uint256'], [from, to, bn(id), bn(amount)]));
  }
  /** ERC-1155 transfer of an unlocked position (re-arms timelock if id has a delay). `to` may be a name. */
  async transfer({ from, to, id, amount, data = '0x' }) {
    to = await this.resolveRecipient(to);
    return this.send(encodeCall(SEL.safeTransferFrom, ['address', 'address', 'uint256', 'uint256', 'bytes'], [from, to, bn(id), bn(amount), data]));
  }
  /** Grant/revoke operator (e.g. the gate for keeper settlement). */
  setApprovalForAll(operator, approved = true) {
    return this.send(encodeCall(SEL.setApprovalForAll, ['address', 'bool'], [operator, approved ? 1n : 0n]));
  }
  /** Approve the gate so keepers can settle your inbound transfers via gate.claim. */
  async approveGate(approved = true) {
    return this.setApprovalForAll(await this.gate(), approved);
  }

  // -- writes: guardian -----------------------------------------------------

  setGuardian(newGuardian) {
    return this.send(encodeCall(SEL.setGuardian, ['address'], [newGuardian]));
  }
  cancelGuardianChange(user) {
    return this.send(encodeCall(SEL.cancelGuardianChange, ['address'], [user]));
  }
  commitGuardian(user) {
    return this.send(encodeCall(SEL.commitGuardian, ['address'], [user]));
  }
  /** Guardian approves a specific pending outflow of `from`. */
  approveTransfer(from, transferId) {
    return this.send(encodeCall(SEL.approveTransfer, ['address', 'uint256'], [from, bn(transferId)]));
  }
  revokeApproval(from, transferId) {
    return this.send(encodeCall(SEL.revokeApproval, ['address', 'uint256'], [from, bn(transferId)]));
  }

  // -- events ---------------------------------------------------------------

  /**
   * Fetch and lightly decode SLOW logs. `topic` is an EVENTS key or topic0 hash.
   * Extra positional `topics` filter indexed args (pass a 32-byte hex or address).
   */
  async getLogs({ event, topics = [], fromBlock = '0x0', toBlock = 'latest', address = this.address } = {}) {
    const topic0 = event ? (EVENTS[event] || event) : null;
    const t = [topic0, ...topics.map(x => x == null ? null : (x.length === 66 ? x : '0x' + padL(x)))];
    return this.request('eth_getLogs', [{ address, topics: t, fromBlock, toBlock }]);
  }

  // -- convenience ----------------------------------------------------------

  formatUnits(v, dec) { return formatUnits(v, dec); }
  parseUnits(v, dec) { return parseUnits(v, dec); }
}

function _now() { return typeof Date !== 'undefined' ? Date.now() : 0; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export { resolveToken, resolveDelay };
