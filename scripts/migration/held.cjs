'use strict';
// Deliberately imports no bot, database, OAuth, scheduler or Discord code.
const http = require('node:http');
const server = http.createServer((req, res) => {
  const health = req.method === 'GET' && req.url === '/health';
  res.writeHead(health ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ mode: 'migration-hold', botStarted: false }));
});
server.listen(Number(process.env.PORT || 3000), '0.0.0.0');
