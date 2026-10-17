'use strict';
// Narrow browser gateway for migration validation. Never accepts bot/ingest writes.
const http = require('node:http');
function headersWithoutHop(headers) {
  const blocked = new Set(['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer',
    'transfer-encoding','upgrade',...String(headers.connection || '').toLowerCase().split(',').map(x=>x.trim())]);
  return Object.fromEntries(Object.entries(headers).filter(([key])=>!blocked.has(key.toLowerCase())));
}
const UPSTREAM = 'http://imortais-oauth-validation:3000';
const PATHS = new Set(['/', '/auth/login', '/auth/callback', '/auth/me', '/auth/logout',
  '/api/events', '/api/roster', '/api/health', '/health']);
const BANNER = '<div style="position:sticky;top:0;z-index:99999;padding:12px;background:#634700;color:white;text-align:center;font:600 15px sans-serif">VALIDAÇÃO DO LOGIN · Cópia do banco · Ações de CTA desativadas</div>';

function allowed(req) {
  const path = String(req.url || '').split('?')[0];
  return req.method === 'GET' && req.url.length <= 8192 &&
    !req.headers['transfer-encoding'] && Number(req.headers['content-length'] || 0) === 0 &&
    (PATHS.has(path) || (/^\/assets\/[A-Za-z0-9_.\/-]+$/.test(path) && !path.split('/').includes('..')));
}

function createGateway(origin, {health, decorate = false, observe = () => {}} = {}) {
  let windowAt = Date.now(), logins = 0;
  const server = http.createServer(async (req, res) => {
    const base = {'Cache-Control':'no-store', 'Referrer-Policy':'no-referrer', 'X-Robots-Tag':'noindex, nofollow'};
    function fail(status, error) {
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(status, {...base, 'Content-Type':'application/json', 'Connection':'close'});
      res.end(JSON.stringify({error, mode:'oauth-validation', botStarted:false}));
    }
    if (!allowed(req)) { req.resume(); fail(403, 'validation_read_only'); return; }
    const path = req.url.split('?')[0];
    if (path === '/health' && health) {
      try {
        const result = await health();
        res.writeHead(result.database ? 200 : 503, {...base, 'Content-Type':'application/json'});
        res.end(JSON.stringify(result));
      } catch { fail(503, 'validation_database_unavailable'); }
      return;
    }
    if (path === '/auth/login') {
      if (Date.now() - windowAt >= 60000) { windowAt = Date.now(); logins = 0; }
      if (++logins > 30) { res.setHeader('Retry-After','60'); fail(429,'validation_login_rate_limit'); return; }
    }
    const headers = headersWithoutHop(req.headers);
    for (const name of ['authorization','forwarded','x-forwarded-for','x-forwarded-host','x-forwarded-proto','x-forwarded-port']) delete headers[name];
    Object.assign(headers, {host:origin.host, 'x-forwarded-proto':'https', 'x-forwarded-host':'imortais.macknacloud.com.br',
      'x-forwarded-for':req.socket.remoteAddress});
    const upstream = http.request({hostname:origin.hostname, port:origin.port, method:'GET', path:req.url, headers}, response => {
      clearTimeout(deadline);
      const output = {...headersWithoutHop(response.headers), ...base};
      observe(path, response.statusCode, response.headers);
      // The banner belongs only to this isolated validation frontend.
      if (decorate && path === '/' && response.statusCode === 200) {
        let body = '', bytes = 0;
        response.setEncoding('utf8');
        response.on('data', chunk => { body += chunk; bytes += Buffer.byteLength(chunk); if (bytes > 2*1024**2) response.destroy(); });
        response.on('end', () => {
          delete output['content-length']; delete output.etag;
          res.writeHead(200,output); res.end(body.replace(/<body([^>]*)>/i,'<body$1>'+BANNER));
        });
      } else {
        res.writeHead(response.statusCode, output); response.pipe(res);
      }
      response.on('error', () => fail(502,'validation_upstream_error'));
    });
    const deadline = setTimeout(() => upstream.destroy(), 25000);
    upstream.on('error', () => { clearTimeout(deadline); fail(503,'validation_not_started'); });
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
    upstream.end();
  });
  server.on('upgrade', (_req, socket) => socket.destroy());
  return server;
}
if (require.main === module) createGateway(new URL(UPSTREAM)).listen(Number(process.env.PORT || 3000),'0.0.0.0');
module.exports = {createGateway, allowed};
