// node --test test/claims.test.js
// Listing claims: validators, the claim endpoint and the admin publish action, with Vercel Blob
// replaced by an in-memory store (no token, no network). Mail + Klaviyo are skipped (no keys).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

process.env.BLOB_READ_WRITE_TOKEN = 'test-token';
process.env.ADMIN_KEY = 'admin-key-for-tests-0123456789abcdef';
delete process.env.SENDGRID_API_KEY; delete process.env.RESEND_API_KEY; delete process.env.KLAVIYO_API_KEY; delete process.env.TURNSTILE_SECRET_KEY;

// ---- in-memory @vercel/blob ----
const store = new Map();
require.cache[require.resolve('@vercel/blob')] = { id: 'blob', filename: 'blob', loaded: true, exports: {
  put: async (pathname, body, opts) => { store.set(pathname, { body: Buffer.isBuffer(body) ? body : Buffer.from(String(body)), opts }); return { url: `https://x.public.blob.vercel-storage.com/${pathname}`, pathname }; },
  get: async (pathname) => { const e = store.get(pathname); if (!e) { const err = new Error('nf'); err.name = 'BlobNotFoundError'; throw err; } return { statusCode: 200, stream: new Blob([e.body]).stream() }; },
  list: async ({ prefix }) => ({ blobs: [...store.keys()].filter(k => k.startsWith(prefix)).map(pathname => ({ pathname, url: 'u' })), hasMore: false }),
} };

const claims = require(path.join('..', 'lib', 'claims'));
const claim = require(path.join('..', 'api', 'claim'));
const admin = require(path.join('..', 'api', 'claims'));
const stores = require(path.join('..', 'lib', 'stores'));

const ANY = stores.chain(Object.keys(require('../data/stores.json').chains.reduce((m, c) => (m[c.slug] = 1, m), {}))[0]).stores[0];
const HOURS = { monday: { open: '10:00 AM', close: '10:00 PM' }, sunday: null };
const FULL = (over = {}) => ({ logo: PNG, phone: '519-555-0100', website: 'thewestore.ca', description: 'Windsor\'s friendliest shop.', hours: HOURS, ...over });
const PNG = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString('base64');

function res() {
  const r = { code: 200, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}
const post = (body, headers = {}) => ({ method: 'POST', headers: { origin: 'https://onboarding.poof.ca', 'x-forwarded-for': '203.0.113.9', ...headers }, body, query: {} });

test('validators: hours, logo, website, instagram, phone', () => {
  assert.equal(claims.v.hours(null), undefined);
  assert.equal(claims.v.hours('x'), undefined);
  assert.equal(claims.v.hours({ monday: null }), undefined); // every day closed → not hours
  assert.equal(claims.v.hours({ monday: { open: '22:00', close: '23:00' } }), undefined); // 24h clock rejected
  assert.equal(claims.v.hours({ monday: { open: '13:00 PM', close: '11:00 PM' } }), undefined);
  assert.deepEqual(claims.v.hours({ monday: { open: '10:00 am', close: '10:30 p.m.' }, sunday: null }).monday, { open: '10:00 AM', close: '10:30 PM' });
  assert.equal(claims.v.logo('data:image/png;base64,AAAA'), undefined); // wrong magic bytes
  assert.equal(claims.v.logo(PNG).ext, 'png');
  assert.equal(claims.v.logo('data:image/svg+xml;base64,AAAA'), undefined);
  assert.equal(claims.v.website('thewestore.ca'), 'https://thewestore.ca/');
  assert.equal(claims.v.website('javascript:alert(1)'), undefined);
  assert.equal(claims.v.instagram('https://www.instagram.com/thewestore/'), 'thewestore');
  assert.equal(claims.v.instagram('@the we store'), undefined);
  assert.equal(claims.v.phone('+1 (519) 555-0100'), '5195550100');
  assert.equal(claims.v.phone('555'), undefined);
});

test('claim: rejects bad store, missing name/email, malformed fields', async () => {
  let r = res(); await claim(post({ id: 'CRSA0000000', name: 'A', email: 'a@b.co' }), r); assert.equal(r.code, 404);
  r = res(); await claim(post({ id: ANY.id, email: 'a@b.co' }), r); assert.equal(r.code, 400); assert.deepEqual(r.body.fields, ['name']);
  r = res(); await claim(post({ id: ANY.id, name: 'Mo', email: 'nope' }), r); assert.equal(r.code, 400); assert.deepEqual(r.body.fields, ['email']);
  r = res(); await claim(post({ id: ANY.id, name: 'Mo', email: 'mo@store.ca', listing: FULL({ phone: '12', instagram: 'bad name' }) }), r);
  assert.equal(r.code, 400); assert.deepEqual(r.body.fields, ['phone', 'instagram']);
  r = res(); await claim(post({ id: ANY.id, name: 'Mo', email: 'mo@store.ca', listing: FULL({ website: '', description: '' }) }), r);
  assert.equal(r.code, 400); assert.deepEqual(r.body.fields, ['website', 'description']);
  r = res(); await claim(post({ id: ANY.id, name: 'Mo', email: 'mo@store.ca', listing: FULL({ hours: { monday: null } }) }), r);
  assert.equal(r.code, 400); assert.deepEqual(r.body.fields, ['hours']);
  r = res(); await claim(post({ id: ANY.id, name: 'Mo', email: 'mo@store.ca', listing: FULL({ logo: '' }) }), r);
  assert.equal(r.code, 400); assert.deepEqual(r.body.fields, ['logo']);
});

test('claim: stores logo publicly, record privately, returns core-shaped fields via admin', async () => {
  const r = res();
  await claim(post({ id: ANY.id, name: 'Mo Khan', email: 'mo@store.ca', listing: FULL({ instagram: '@thewestore' }) }), r);
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(r.body.revision, 1);
  assert.match(r.body.logoUrl, /\/claims\/CRSA\d+\/logo\.png$/);
  assert.equal(store.get(`claims/${ANY.id}/logo.png`).opts.access, 'public');
  assert.equal(store.get(`claims/${ANY.id}/claim.json`).opts.access, 'private');

  const a = res();
  await admin({ method: 'GET', headers: { 'x-admin-key': process.env.ADMIN_KEY }, query: { id: ANY.id } }, a);
  assert.equal(a.code, 200);
  assert.equal(a.body.claim.status, 'pending');
  assert.equal(a.body.core.imageUrl, r.body.logoUrl);
  assert.equal(a.body.core.contactNumber, '5195550100');
  assert.equal(a.body.core.instagramUrl, 'https://instagram.com/thewestore');
  assert.equal(a.body.core.operationHours.sunday, null);
  assert.deepEqual(a.body.core.operationHours.monday, { open: '10:00 AM', close: '10:00 PM' });
  assert.equal(a.body.core.isProfileComplete, true);
  assert.equal(a.body.core.poof.stage, 'claimed');
});

test('claim: second submit keeps the logo when none is sent and bumps revision', async () => {
  const r = res();
  await claim(post({ id: ANY.id, name: 'Mo Khan', email: 'mo@store.ca', listing: FULL({ logo: '', description: 'Updated.' }) }), r);
  assert.equal(r.code, 200);
  assert.equal(r.body.revision, 2);
  assert.match(r.body.logoUrl, /logo\.png$/);
});

test('admin: requires header key, lists, publishes once', async () => {
  let a = res(); await admin({ method: 'GET', headers: {}, query: {} }, a); assert.equal(a.code, 401);
  a = res(); await admin({ method: 'GET', headers: { 'x-admin-key': process.env.ADMIN_KEY }, query: {} }, a);
  assert.equal(a.body.claims.length, 1);
  a = res(); await admin({ method: 'POST', headers: { 'x-admin-key': process.env.ADMIN_KEY }, body: { action: 'publish', id: ANY.id, url: 'poof.ca/stores/we-store' }, query: {} }, a);
  assert.equal(a.code, 200); assert.equal(a.body.status, 'published'); assert.equal(a.body.liveUrl, 'https://poof.ca/stores/we-store');
  const first = a.body.publishedAt;
  a = res(); await admin({ method: 'POST', headers: { 'x-admin-key': process.env.ADMIN_KEY }, body: { action: 'publish', id: ANY.id }, query: {} }, a);
  assert.equal(a.body.publishedAt, first);
  a = res(); await admin({ method: 'GET', headers: { 'x-admin-key': process.env.ADMIN_KEY }, query: { id: ANY.id } }, a);
  assert.equal(a.body.core.poof.stage, 'live');
});

test('claim: honeypot and cross-origin are rejected quietly', async () => {
  let r = res(); await claim(post({ id: ANY.id, name: 'Bot', email: 'b@b.co', website: 'http://spam', listing: FULL() }), r); assert.equal(r.code, 200); assert.equal(store.size, 2);
  r = res(); await claim(post({ id: ANY.id, name: 'X', email: 'x@x.co', listing: FULL() }, { origin: 'https://evil.example' }), r); assert.equal(r.code, 403);
});
