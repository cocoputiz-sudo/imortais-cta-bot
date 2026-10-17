'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { createBridge, validateUpstream } = require('./railway-bridge/server.cjs');

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return 'http://127.0.0.1:' + server.address().port;
}
function request(url, opts = {}, body = '') {
  return new Promise((resolve, reject) => {
    const req = http.request(url, opts, res => {
      let raw = '';
      res.on('data', data => { raw += data; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

(async () => {
  assert.throws(() => validateUpstream('http://127.0.0.1'));
  assert.throws(() => validateUpstream('https://evil.example'));
  let received;
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', data => { body += data; });
    req.on('end', () => {
      received = { headers: req.headers, body, path: req.url };
      res.writeHead(201, { 'Content-Type': 'text/event-stream', 'Set-Cookie': 'sid=signed; HttpOnly; Secure',
        'Connection': 'keep-alive, x-remove', 'X-Remove': 'must-not-forward' });
      res.write('data: first\n\n');
      setTimeout(() => res.end('data: second\n\n'), 15);
    });
  });
  let bridge, hold;
  try {
    const origin = new URL(await listen(upstream));
    bridge = createBridge(origin, true);
    const base = await listen(bridge);
    const response = await request(base + '/api/telemetry/ingest?q=1', { method: 'POST', headers: {
      'Content-Type': 'application/json', Authorization: 'Bearer test', Cookie: 'sid=test',
      Connection: 'close, x-remove', 'X-Remove': 'must-not-forward', 'X-Forwarded-For': 'forged' } }, '{"event":1}');
    assert.equal(response.status, 201);
    assert.equal(response.raw, 'data: first\n\ndata: second\n\n');
    assert.equal(response.headers['set-cookie'][0], 'sid=signed; HttpOnly; Secure');
    assert.equal(received.headers.authorization, 'Bearer test');
    assert.equal(received.headers.cookie, 'sid=test');
    assert.equal(received.body, '{"event":1}');
    assert.equal(received.path, '/api/telemetry/ingest?q=1');
    assert.equal(received.headers['x-remove'], undefined);
    assert.equal(response.headers['x-remove'], undefined);
    assert.notEqual(received.headers['x-forwarded-for'], 'forged');
    const invalid = await request(base + '//evil.example/path');
    assert.equal(invalid.status, 400);
    hold = createBridge(origin);
    const held = await request(await listen(hold));
    assert.equal(held.status, 503);
    assert.equal(held.headers['retry-after'], '30');
    await new Promise(resolve => upstream.close(resolve));
    const failed = await request(base + '/api/health');
    assert.equal(failed.status, 502);
    assert.equal(failed.headers['retry-after'], '30');
    console.log('BRIDGE_OK: POST/auth/cookies/query/SSE preserved; hold/failure refuse acknowledgements; endpoint guarded.');
  } finally {
    for (const server of [bridge, hold, upstream]) if (server?.listening) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
