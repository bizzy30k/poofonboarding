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
  del: async (pathname) => { store.delete(pathname); },
} };

const claims = require(path.join('..', 'lib', 'claims'));
const claim = require(path.join('..', 'api', 'claim'));
const admin = require(path.join('..', 'api', 'claims'));
const bulk = require(path.join('..', 'api', 'claim-bulk'));
const placesLib = require(path.join('..', 'lib', 'places'));
const stores = require(path.join('..', 'lib', 'stores'));

const CHAIN = stores.chain(require('../data/stores.json').chains.find(c => c.stores.length >= 3).slug);
const ANY = CHAIN.stores[0];
let TOKEN = '';
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
  assert.ok(r.body.token && r.body.token.length === 64, 'edit token');
  assert.ok(r.body.siblings.length >= 2, 'unclaimed siblings listed');
  assert.ok(!r.body.siblings.find(x => x.id === ANY.id));
  TOKEN = r.body.token;
  assert.match(r.body.logoUrl, /\/claims-dev\/CRSA\d+\/logo\.png$/);
  assert.equal(store.get(`claims-dev/${ANY.id}/logo.png`).opts.access, 'public');
  const enc = store.get(`claims-dev/${ANY.id}/claim.enc`);
  assert.equal(enc.opts.access, 'public');
  assert.ok(!enc.body.toString('utf8').includes('mo@store.ca'), 'record must not be readable in the blob');

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

test('claim: locked after the first claim — 409 without the edit token, edit with it keeps logo + bumps revision', async () => {
  let r = res();
  await claim(post({ id: ANY.id, name: 'Someone Else', email: 'else@other.ca', listing: FULL() }), r);
  assert.equal(r.code, 409); assert.equal(r.body.error, 'already_claimed'); assert.ok(r.body.claimedAt);
  r = res();
  await claim(post({ id: ANY.id, name: 'Mo Khan', email: 'mo@store.ca', t: 'nope', listing: FULL() }), r);
  assert.equal(r.code, 409);
  r = res();
  await claim(post({ id: ANY.id, name: 'Mo Khan', email: 'mo@store.ca', t: TOKEN, listing: FULL({ logo: '', description: 'Updated.' }) }), r);
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(r.body.revision, 2);
  assert.match(r.body.logoUrl, /logo\.png$/);
  assert.equal(r.body.token, TOKEN, 'token is stable across edits');
});

test('claim: GET status — public says claimed, owner token returns the record for prefill', async () => {
  let r = res(); await claim({ method: 'GET', headers: {}, query: { id: ANY.id } }, r);
  assert.equal(r.code, 200); assert.equal(r.body.claimed, true); assert.ok(r.body.claimedAt); assert.equal(r.body.contact, undefined);
  r = res(); await claim({ method: 'GET', headers: {}, query: { id: ANY.id, t: 'bad' } }, r);
  assert.equal(r.body.owner, undefined);
  r = res(); await claim({ method: 'GET', headers: {}, query: { id: ANY.id, t: TOKEN } }, r);
  assert.equal(r.body.owner, true); assert.equal(r.body.contact.email, 'mo@store.ca'); assert.equal(r.body.listing.description, 'Updated.');
  assert.ok(r.body.siblings.length >= 2);
  r = res(); await claim({ method: 'GET', headers: {}, query: { id: CHAIN.stores[1].id } }, r);
  assert.deepEqual(r.body, { claimed: false });
});

test('claim-bulk: claims the siblings with the source listing, skips taken/foreign stores, needs the token', async () => {
  const sib = CHAIN.stores.slice(1, 3).map(s => s.id);
  const other = stores.load().chains.find(c => c.slug !== CHAIN.slug).stores[0].id;
  let r = res(); await bulk(post({ from: ANY.id, t: 'bad', ids: sib }), r); assert.equal(r.code, 403);
  r = res(); await bulk(post({ from: ANY.id, t: TOKEN, ids: [...sib, other, ANY.id, 'CRSA0000000'] }), r);
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.claimed, sib);
  assert.deepEqual(r.body.skipped.map(x => x.reason).sort(), ['different licence', 'no such store']);
  const a = res(); await admin({ method: 'GET', headers: { 'x-admin-key': process.env.ADMIN_KEY }, query: { id: sib[0] } }, a);
  assert.equal(a.body.claim.copiedFrom, ANY.id);
  assert.equal(a.body.claim.contact.email, 'mo@store.ca');
  assert.equal(a.body.core.imageUrl, `https://x.public.blob.vercel-storage.com/claims-dev/${ANY.id}/logo.png`);
  assert.equal(a.body.core.contactNumber, '5195550100'); // no Places key in tests → copied from source
  assert.ok(a.body.claim.needsReview.length === 2);
  // second run: nothing left to claim
  r = res(); await bulk(post({ from: ANY.id, t: TOKEN, ids: sib }), r);
  assert.deepEqual(r.body.claimed, []); assert.equal(r.body.skipped[0].reason, 'already claimed');
  // the GET for the source no longer lists them
  r = res(); await claim({ method: 'GET', headers: {}, query: { id: ANY.id, t: TOKEN } }, r);
  assert.ok(!r.body.siblings.find(x => sib.includes(x.id)));
});

test('claim: "email it later" saves without a logo and flags it; google photo without Places → 400', async () => {
  const id = CHAIN.stores[5].id;
  let r = res(); await claim(post({ id, name: 'Later Owner', email: 'later@store.ca', listing: FULL({ logo: '', logoLater: true }) }, { 'x-forwarded-for': '198.51.100.9' }), r);
  assert.equal(r.code, 200, JSON.stringify(r.body)); assert.equal(r.body.logoUrl, null);
  const a = res(); await admin({ method: 'GET', headers: { 'x-admin-key': process.env.ADMIN_KEY }, query: { id } }, a);
  assert.ok(a.body.claim.needsReview[0].includes('no logo yet')); assert.equal(a.body.core.isProfileComplete, false);
  r = res(); await claim(post({ id: CHAIN.stores[6].id, name: 'G', email: 'g@store.ca', listing: FULL({ logo: '', logoFrom: 'google' }) }, { 'x-forwarded-for': '198.51.100.10' }), r);
  assert.equal(r.code, 400, JSON.stringify(r.body)); assert.deepEqual(r.body.fields, ['logo']); // no Places key in tests
});

test('places: opening time without a meridiem', () => {
  const h = placesLib.hoursFromWeekdayText(['Monday: 9:00 – 5:00 PM', 'Tuesday: 1:00 – 5:00 PM', 'Wednesday: 11:00 – 11:00 PM']);
  assert.deepEqual(h.monday, { open: '9:00 AM', close: '5:00 PM' });
  assert.deepEqual(h.tuesday, { open: '1:00 PM', close: '5:00 PM' });
  assert.deepEqual(h.wednesday, { open: '11:00 AM', close: '11:00 PM' });
});

test('admin: release unlocks a store so it can be claimed again', async () => {
  const id = CHAIN.stores[1].id;
  let a = res(); await admin({ method: 'POST', headers: { 'x-admin-key': process.env.ADMIN_KEY }, body: { action: 'release', id }, query: {} }, a);
  assert.equal(a.code, 200); assert.equal(a.body.released, true);
  let r = res(); await claim({ method: 'GET', headers: {}, query: { id } }, r); assert.deepEqual(r.body, { claimed: false });
  r = res(); await claim(post({ id, name: 'Real Owner', email: 'owner@real.ca', listing: FULL() }, { 'x-forwarded-for': '198.51.100.7' }), r);
  assert.equal(r.code, 200, JSON.stringify(r.body)); assert.equal(r.body.revision, 1);
});

test('places: weekday_text → 12-hour hours; ownership scoring', () => {
  const h = placesLib.hoursFromWeekdayText(['Monday: 10:00 AM – 9:00 PM', 'Tuesday: 10:00\u202fAM\u2009–\u20099:00\u202fPM', 'Wednesday: Closed', 'Thursday: Open 24 hours', 'Friday: 9:00 AM – 12:00 PM, 1:00 – 5:00 PM', 'Sunday: 11 AM – 6 PM']);
  assert.deepEqual(h.monday, { open: '10:00 AM', close: '9:00 PM' });
  assert.deepEqual(h.tuesday, { open: '10:00 AM', close: '9:00 PM' });
  assert.equal(h.wednesday, null);
  assert.deepEqual(h.thursday, { open: '12:00 AM', close: '11:59 PM' });
  assert.deepEqual(h.friday, { open: '9:00 AM', close: '5:00 PM' });
  assert.deepEqual(h.saturday, null);
  assert.deepEqual(h.sunday, { open: '11:00 AM', close: '6:00 PM' });
  assert.ok(claims.v.hours(h), 'parsed hours pass the claim validator');
  assert.equal(placesLib.hoursFromWeekdayText(null), null);
  assert.equal(placesLib.hoursFromWeekdayText(['garbage']), null);

  const rec = (email, website, phone) => ({ contact: { name: 'M', email }, listing: { website: claims.v.website(website), phone: claims.v.phone(phone) } });
  const g = { phone: '(519) 419-1724', website: 'https://www.crownleaf.ca/' };
  assert.equal(claims.ownership(rec('mo@crownleaf.ca', 'crownleaf.ca', '519-000-0000'), g).verdict, 'LIKELY');
  assert.equal(claims.ownership(rec('mo@gmail.com', 'crownleaf.ca', '5194191724'), g).verdict, 'LIKELY');
  const o = claims.ownership(rec('mo@gmail.com', 'other.ca', '519-000-0000'), g);
  assert.equal(o.verdict, 'REVIEW'); assert.ok(o.line.includes('free-mail')); assert.ok(o.line.includes('≠ Google'));
  assert.equal(claims.ownership(rec('mo@gmail.com', 'crownleaf.ca', '519-000-0000'), null).verdict, 'REVIEW');
});

test('admin: requires header key, lists, publishes once', async () => {
  let a = res(); await admin({ method: 'GET', headers: {}, query: {} }, a); assert.equal(a.code, 401);
  a = res(); await admin({ method: 'GET', headers: { 'x-admin-key': process.env.ADMIN_KEY }, query: {} }, a);
  assert.ok(a.body.claims.length >= 1);
  a = res(); await admin({ method: 'POST', headers: { 'x-admin-key': process.env.ADMIN_KEY }, body: { action: 'publish', id: ANY.id, url: 'poof.ca/stores/we-store' }, query: {} }, a);
  assert.equal(a.code, 200); assert.equal(a.body.status, 'published'); assert.equal(a.body.liveUrl, 'https://poof.ca/stores/we-store');
  const first = a.body.publishedAt;
  a = res(); await admin({ method: 'POST', headers: { 'x-admin-key': process.env.ADMIN_KEY }, body: { action: 'publish', id: ANY.id }, query: {} }, a);
  assert.equal(a.body.publishedAt, first);
  a = res(); await admin({ method: 'GET', headers: { 'x-admin-key': process.env.ADMIN_KEY }, query: { id: ANY.id } }, a);
  assert.equal(a.body.core.poof.stage, 'live');
});

test('claim-link: same reply whether or not the email matches; edit of a published record goes back to pending', async () => {
  const link = require(path.join('..', 'api', 'claim-link'));
  let r = res(); await link(post({ id: ANY.id, email: 'mo@store.ca' }), r); assert.equal(r.code, 200); assert.deepEqual(r.body, { ok: true });
  r = res(); await link(post({ id: ANY.id, email: 'stranger@x.co' }), r); assert.equal(r.code, 200); assert.deepEqual(r.body, { ok: true });
  r = res(); await link(post({ id: ANY.id, email: 'nope' }), r); assert.equal(r.code, 400);
  // ANY was published in the admin test above; an owner edit must come back as pending with the live URL kept
  r = res(); await claim(post({ id: ANY.id, name: 'Mo Khan', email: 'mo@store.ca', t: TOKEN, listing: FULL({ logo: '', description: 'Edited after publish.' }) }, { 'x-forwarded-for': '198.51.100.8' }), r);
  assert.equal(r.code, 200, JSON.stringify(r.body));
  const a = res(); await admin({ method: 'GET', headers: { 'x-admin-key': process.env.ADMIN_KEY }, query: { id: ANY.id } }, a);
  assert.equal(a.body.claim.status, 'pending'); assert.equal(a.body.claim.editedSincePublish, true); assert.ok(a.body.claim.liveUrl);
  assert.equal(a.body.core.poof.claimedAt, a.body.claim.claimedAt);
  assert.equal(a.body.claim.editor, undefined, 'same email, different case → not an editor');
});

test('claim: honeypot and cross-origin are rejected quietly', async () => {
  const before = store.size;
  let r = res(); await claim(post({ id: ANY.id, name: 'Bot', email: 'b@b.co', website: 'http://spam', listing: FULL() }), r); assert.equal(r.code, 200); assert.equal(store.size, before);
  r = res(); await claim(post({ id: ANY.id, name: 'X', email: 'x@x.co', listing: FULL() }, { origin: 'https://evil.example' }), r); assert.equal(r.code, 403);
});
