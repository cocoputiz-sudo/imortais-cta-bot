'use strict';
const http = require('node:http');
const https = require('node:https');

const UPSTREAM = 'https://imortais.macknacloud.com.br';
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade']);

function headersWithoutHop(headers) {
  const blocked = new Set([...HOP, ...String(headers.connection || '').toLowerCase().split(',').map(s => s.trim())]);
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !blocked.has(key.toLowerCase())));
}

function validateUpstream(raw) {
  if (raw !== UPSTREAM) throw new Error('Destino de encaminhamento recusado.');
  return new URL(raw);
}

// Origin injection exists only for the local regression test; CLI always validates.
function createBridge(origin, active = false) {
  const transport = origin.protocol === 'https:' ? https : http;
  const server = http.createServer((req, res) => {
    function fail(status) {
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': '30' });
      res.end(JSON.stringify({ error: 'temporarily_unavailable' }));
    }
    if (!active) { fail(503); return; }
    // Path stays an opaque origin-form request target, never a new URL/host.
    if (!req.url.startsWith('/') || req.url.startsWith('//')) { fail(400); return; }
    const headers = headersWithoutHop(req.headers);
    delete headers.forwarded;
    delete headers['x-forwarded-port'];
    headers.host = origin.host;
    headers['x-forwarded-host'] = 'cta-imortais.up.railway.app';
    headers['x-forwarded-proto'] = 'https';
    headers['x-forwarded-for'] = req.socket.remoteAddress;
    const upstream = transport.request({ hostname: origin.hostname, port: origin.port || undefined,
      method: req.method, path: req.url, headers, rejectUnauthorized: true }, response => {
      clearTimeout(waitHeaders);
      res.writeHead(response.statusCode, headersWithoutHop(response.headers));
      response.on('error', () => res.destroy());
      response.pipe(res);
    });
    const waitHeaders = setTimeout(() => upstream.destroy(), 60000);
    upstream.on('error', () => { clearTimeout(waitHeaders); fail(502); });
    req.on('aborted', () => upstream.destroy());
    req.on('error', () => upstream.destroy());
    res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
    req.pipe(upstream);
  });
  server.on('upgrade', (_req, socket) => socket.destroy());
  return server;
}

if (require.main === module) {
  const origin = validateUpstream(process.env.IMORTAIS_UPSTREAM || UPSTREAM);
  const active = process.env.IMORTAIS_BRIDGE_MODE === 'forward';
  createBridge(origin, active).listen(Number(process.env.PORT || 8080), '0.0.0.0');
}
module.exports = { createBridge, validateUpstream, headersWithoutHop };
