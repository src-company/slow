/**
 * A round-robin JSON-RPC pool that fails over on ANY error.
 *
 * WHY NOT viem's `fallback`. That transport fails over on TRANSPORT errors — a
 * refused connection, a timeout, a 5xx. Every failure this pool was written for
 * arrives as a perfectly well-formed JSON-RPC error response with HTTP 200:
 *
 *   drpc          "Can't route your request to suitable provider"   (code 12)
 *   publicnode    "Archive requests require a personal token"       (code -32602)
 *   1rpc          "eth_getLogs is limited to 0 - 50 blocks range"
 *   nodies        "Block range too large: maximum allowed is 50 blocks"
 *   cloudflare    "Internal error"
 *
 * A fallback that only watches the transport sees five successes and returns
 * five errors to the caller. So this treats an error RESULT the same as a dead
 * socket: the endpoint did not answer the question, try the next one.
 *
 * WHY THE SPANS ARE LEARNED. The public endpoints that serve `eth_getLogs` at
 * all disagree about how wide a range they will serve — 50 blocks on some, a
 * few hundred on others, and the limit is not discoverable except by asking.
 * Hard-coding the smallest one makes every scan ten times more expensive than
 * it needs to be against the endpoints that would have answered in one call. So
 * each endpoint starts optimistic and halves its own span whenever it says the
 * range was too wide, and the pool remembers.
 */

const RANGE_ERROR = /range too large|limited to|too many blocks|exceeds? the .*range|max(imum)? .*blocks/i;

/**
 * A rate limit is the one refusal that is worth WAITING on. Every other error
 * means "not from me, ask someone else"; this one means "yes, but slower", and
 * on a chain with a single public endpoint — Robinhood has one — treating it as
 * a dead endpoint fails a scan that would have succeeded a second later.
 */
const RATE_ERROR = /too many requests|rate ?limit|429|throttl/i;

/** An endpoint that just failed is skipped for a while rather than retried in a loop. */
const COOLDOWN_MS = 30_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createPool(urls, {
  maxSpan = 500, minSpan = 25, timeoutMs = 12_000,
  pacingMs = 120,      // between chunks, so a scan does not trip a rate limit itself
  maxBackoffs = 6,     // how many times one range may wait out a rate limit
} = {}) {
  if (!urls || urls.length === 0) throw new Error('a pool needs at least one url');
  const eps = urls.map((url) => ({
    url,
    span: maxSpan,      // the widest getLogs range this endpoint has not refused
    downUntil: 0,       // epoch ms; skipped while in the future
    fails: 0,
    calls: 0,
  }));
  let next = 0;

  /**
   * Every endpoint, round-robin, with the ones in cooldown moved to the back.
   *
   * Cooldown DEPRIORITISES rather than excludes, which matters more than it
   * sounds: excluding meant that once four of five endpoints were cooling, a
   * pass consisted of the single remaining endpoint, and its next hiccup failed
   * the whole call while four recovered endpoints sat unasked. A pass now always
   * tries everything it has, in the order most likely to answer.
   */
  const order = () => {
    const now = Date.now();
    const out = [];
    for (let k = 0; k < eps.length; k++) out.push(eps[(next + k) % eps.length]);
    next = (next + 1) % eps.length;
    return [...out.filter((e) => e.downUntil <= now), ...out.filter((e) => e.downUntil > now)];
  };

  async function once(ep, method, params) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(ep.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: ctl.signal,
      });
      const text = await r.text();
      let j;
      try { j = JSON.parse(text); }
      catch { throw new Error(`non-JSON response (HTTP ${r.status})`); }
      if (j.error) throw new Error(j.error.message ?? JSON.stringify(j.error));
      if (j.result === undefined) throw new Error('no result field');
      return j.result;
    } finally { clearTimeout(timer); }
  }

  /** One call, tried across the pool. Throws only if every endpoint refused. */
  async function send(method, params) {
    let errors = [];
    for (let attempt = 0; attempt <= maxBackoffs; attempt++) {
      errors = [];
      let rateLimited = false;
      for (const ep of order()) {
        try {
          const out = await once(ep, method, params);
          ep.fails = 0; ep.calls++;
          return out;
        } catch (e) {
          if (RATE_ERROR.test(e.message)) {
            rateLimited = true;
            ep.downUntil = Date.now() + 2_000;
          } else {
            ep.fails++; ep.downUntil = Date.now() + COOLDOWN_MS;
          }
          errors.push(`${ep.url}: ${e.message}`);
        }
      }
      if (!rateLimited) break;
      await sleep(250 * 2 ** attempt);
    }
    throw new Error(`all ${eps.length} endpoints failed — ${errors.join(' | ')}`);
  }

  /**
   * `eth_getLogs` over an arbitrary range, split to whatever each endpoint will
   * actually serve. Returns logs in block order.
   *
   * A range refusal is not counted as an endpoint failure: the endpoint is
   * healthy and told us something useful. It narrows its span and is retried
   * immediately, which is why a 50-block-cap endpoint converges in two calls
   * rather than being cooled down out of the pool.
   */
  async function getLogs({ address, topics, fromBlock, toBlock }) {
    const out = [];
    let from = BigInt(fromBlock);
    const end = BigInt(toBlock);
    let guard = 0;
    let backoffs = 0;
    while (from <= end) {
      if (++guard > 10_000) throw new Error('getLogs made no progress');
      let got = false;
      // A narrowing is PROGRESS, not a failure: the endpoint told us how to ask
      // properly. Throwing after one pass meant a 50-block-cap endpoint starting
      // at 500 never got to converge — it narrowed once and the whole call gave
      // up while the answer was four halvings away.
      let narrowed = false;
      let rateLimited = false;
      const errors = [];
      for (const ep of order()) {
        const to = from + BigInt(ep.span) - 1n > end ? end : from + BigInt(ep.span) - 1n;
        try {
          const logs = await once(ep, 'eth_getLogs', [{
            address,
            topics,
            fromBlock: '0x' + from.toString(16),
            toBlock: '0x' + to.toString(16),
          }]);
          ep.fails = 0; ep.calls++;
          out.push(...logs);
          from = to + 1n;
          got = true;
          break;
        } catch (e) {
          if (RANGE_ERROR.test(e.message) && ep.span > minSpan) {
            ep.span = Math.max(minSpan, Math.floor(ep.span / 2));
            narrowed = true;
            errors.push(`${ep.url}: narrowed to ${ep.span}`);
          } else if (RATE_ERROR.test(e.message)) {
            rateLimited = true;
            ep.downUntil = Date.now() + 2_000;
            errors.push(`${ep.url}: rate limited`);
          } else {
            ep.fails++; ep.downUntil = Date.now() + COOLDOWN_MS;
            errors.push(`${ep.url}: ${e.message}`);
          }
        }
      }
      if (got) {
        if (pacingMs && from <= end) await sleep(pacingMs);
        backoffs = 0;
      } else if (rateLimited && backoffs < maxBackoffs) {
        await sleep(250 * 2 ** backoffs++);
      } else if (!narrowed) {
        throw new Error(`getLogs ${from}-${end} failed — ${errors.join(' | ')}`);
      }
    }
    return out;
  }

  const stats = () => eps.map((e) => ({ url: e.url, span: e.span, calls: e.calls, fails: e.fails }));

  return { send, getLogs, stats };
}
