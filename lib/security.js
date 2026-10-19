// Security primitives shared by every API handler.
//
//  - safeEqual        constant-time string compare
//  - requireAdmin     x-admin-key header only (never query string), constant-time
//  - sessionToken     HMAC over a Stripe customer id, handed to the browser when the
//                     customer is created; every later update must present it, so
//                     knowing a cus_ id (they're in emails) is not enough to edit a record
//  - rateLimit        fixed-window limiter keyed by IP (+ optional secondary key).
//                     Per-instance — a soft brake, not a wall. Vercel WAF rules are the wall.
//  - clientIp         first hop of x-forwarded-for (trustworthy on Vercel)
//  - fetchT           fetch with a hard timeout — no outbound call may hang a lambda
//  - validate         tiny schema checker for POST bodies (strings, lengths, emails, arrays)
const crypto = require('crypto');
const config = require('./config');

function safeEqual(a, b) {
  const A = crypto.createHash('sha256').update(String(a || '')).digest();
  const B = crypto.createHash('sha256').update(String(b || '')).digest();
  return crypto.timingSafeEqual(A, B);
}

function requireAdmin(req, res) {
  const key = req.headers['x-admin-key'];
  if (!config.ADMIN_KEY || !key || !safeEqual(key, config.ADMIN_KEY)) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

// ---- session token (binds a browser to the customer record it created) ----
function sessionToken(customerId) {
  return crypto.createHmac('sha256', config.signingSecret()).update(`session:${customerId}`).digest('hex');
}
function checkSession(customerId, token) {
  return /^cus_[A-Za-z0-9]+$/.test(customerId || '') && !!token && safeEqual(sessionToken(customerId), token);
}

// ---- rate limiting ----
const buckets = new Map(); // key → { n, reset }
function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  if (buckets.size > 5000) for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k);
  const b = buckets.get(key);
  if (!b || b.reset < now) { buckets.set(key, { n: 1, reset: now + windowMs }); return true; }
  b.n += 1;
  return b.n <= limit;
}
function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
}
function tooMany(res) { res.setHeader('Retry-After', '60'); return res.status(429).json({ error: 'Too many requests. Please wait a minute.' }); }

// ---- same-origin check for state-changing requests ----
function sameOrigin(req) {
  let origin = req.headers.origin || null;
  if (!origin && req.headers.referer) { try { origin = new URL(req.headers.referer).origin; } catch (e) { origin = null; } }
  if (!origin || origin === 'null') return !req.headers.referer; // no origin at all → non-browser client; 'null' origin with a referer → sandboxed/cross-site, refuse
  const norm = (u) => { try { return new URL(u).origin; } catch (e) { return null; } };
  const allowed = new Set([norm(config.SITE_URL), 'https://poofonboarding.vercel.app', 'http://localhost:3000', process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null].filter(Boolean));
  return allowed.has(origin) || /^https:\/\/poof-?onboarding(-[a-z0-9-]+)?\.vercel\.app$/.test(origin);
}

// ---- outbound fetch with timeout ----
async function fetchT(url, opts = {}, ms = 5000) {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(ms) });
}

// ---- body parsing + validation ----
function body(req) {
  try { return typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); } catch (e) { return null; }
}
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;
const str = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max ? v.trim() : undefined;
const optStr = (v, max) => (v == null || v === '') ? '' : (typeof v === 'string' && v.length <= max ? v.trim() : undefined);
const email = (v) => { const s = str(v, 254); return s && EMAIL.test(s) ? s.toLowerCase() : undefined; };
const crsaList = (v, max = 200) => Array.isArray(v) && v.length <= max && v.every(id => typeof id === 'string' && /^CRSA\d{6,8}$/.test(id)) ? [...new Set(v)] : undefined;
const slug = (v) => { const s = str(v, 80); return s && /^[a-z0-9-]+$/.test(s) ? s : undefined; };

module.exports = { safeEqual, requireAdmin, sessionToken, checkSession, rateLimit, clientIp, tooMany, sameOrigin, fetchT, body, v: { str, optStr, email, crsaList, slug, EMAIL } };
