#!/usr/bin/env node
/**
 * Serve dapp/page.html on localhost — real wallet, real transactions, the exact
 * bytes the chunker would deploy.
 *
 * Usage: node scripts/serve.mjs [port]
 */
import http from 'node:http';
import {loadManifest, readPage} from './lib.mjs';

const m = loadManifest();
const {bytes} = readPage(m);
const port = Number(process.argv[2]) || 8244;

http.createServer((req, res) => {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': bytes.length,
    'cache-control': 'no-store',
  });
  res.end(req.method === 'HEAD' ? undefined : bytes);
}).listen(port, () => {
  console.log(`${m.page} (${bytes.length.toLocaleString()} B) on http://localhost:${port}/`);
  console.log('Every path serves the same document, exactly as a gateway does.');
});
