#!/usr/bin/env node
// Local dev server that mimics Vercel: static files from public/, api/*.js as
// handlers. Run: node scripts/dev-server.js   (reads .env if present)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const root = path.join(__dirname, '..');
try { fs.readFileSync(path.join(root, '.env'), 'utf8').split('\n').forEach(l => { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }); } catch (e) {}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
  res.send = (b) => res.end(b);
  req.query = Object.fromEntries(u.searchParams);
  if (u.pathname.startsWith('/api/')) {
    const name = u.pathname.slice(5).replace(/[^a-z0-9-]/gi, '');
    const file = path.join(root, 'api', name + '.js');
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'no such api' });
    let body = ''; for await (const c of req) body += c;
    req.body = body ? (() => { try { return JSON.parse(body); } catch (e) { return body; } })() : undefined;
    delete require.cache[require.resolve(file)];
    try { await require(file)(req, res); } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
    return;
  }
  let p = (u.pathname === '/' || /^\/(s|r)\//.test(u.pathname)) ? '/index.html' : u.pathname;
  if (!path.extname(p)) p += '.html';
  const f = path.join(root, 'public', p);
  if (!f.startsWith(path.join(root, 'public')) || !fs.existsSync(f)) { res.status(404).end('not found'); return; }
  res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream');
  fs.createReadStream(f).pipe(res);
}).listen(process.env.PORT || 3000, () => console.log('http://localhost:' + (process.env.PORT || 3000)));
