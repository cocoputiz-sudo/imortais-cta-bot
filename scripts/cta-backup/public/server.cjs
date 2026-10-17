'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const routes = new Map([
  ['/', 'index.html'],
  ['/privacidade', 'privacidade.html'],
  ['/termos', 'termos.html'],
]);
const pages = new Map([...routes].map(([url, file]) => [url, fs.readFileSync(path.join(__dirname, file))]));
const server = http.createServer((req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    return res.end();
  }
  let url;
  try { url = new URL(req.url, 'http://localhost').pathname; }
  catch { res.writeHead(400); return res.end(); }
  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(req.method === 'HEAD' ? undefined : '{"ok":true}');
  }
  const content = pages.get(url);
  if (!content) { res.writeHead(404); return res.end('Página não encontrada.'); }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
  res.end(req.method === 'HEAD' ? undefined : content);
});
server.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => console.log('IMORTAIS Backups: páginas públicas disponíveis'));
