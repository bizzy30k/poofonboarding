// Security regression tests. Run: node --test test/
// Mocks Stripe; exercises the exact attack paths from the 2026-10-19 audit.
const { test } = require('node:test');
const assert = require('node:assert');
const Module = require('module');

process.env.SIGNING_SECRET = 'test-signing-secret-at-least-32-chars-long-ok';
process.env.STRIPE_SECRET_KEY = 'sk_test_x';
process.env.ADMIN_KEY = 'admin-test-key';
process.env.SITE_URL = 'https://onboarding.poof.ca';
process.env.VERCEL_ENV = 'production';

// ---- Stripe mock -------------------------------------------------------------
const db = { customers: new Map(), setupIntents: new Map(), subs: [] };
let nextId = 1;
const stripeMock = {
  customers: {
    create: async (o) => { const id = `cus_test${nextId++}`; const c = { id, ...o, metadata: { ...o.metadata }, invoice_settings: {} }; db.customers.set(id, c); return c; },
    retrieve: async (id) => { const c = db.customers.get(id); if (!c) throw new Error('No such customer'); return c; },
    update: async (id, o) => { const c = db.customers.get(id); Object.assign(c, o, { metadata: { ...c.metadata, ...(o.metadata || {}) } }); return c; },
    search: () => ({ async *[Symbol.asyncIterator]() { for (const c of db.customers.values()) yield c; }, data: [...db.customers.values()], has_more: false }),
    // Email lookup is opt-in per test (db.listByEmail) so the shared goodBody() email doesn't trip the dedupe elsewhere.
    list: async ({ email }) => ({ data: db.listByEmail ? [...db.customers.values()].filter(c => c.email === email) : [] }),
  },
  paymentMethods: { retrieve: async () => ({ id: 'pm_x', billing_details: { name: 'Mo Khan', email: 'mo@store.ca', address: { line1: '12 Billing St', city: 'Windsor', state: 'ON', postal_code: 'N9A 1A1', country: 'CA' } } }) },
  setupIntents: {
    create: async (o) => { const id = `seti_${nextId++}`; const si = { id, customer: o.customer, status: 'succeeded', payment_method: 'pm_x', client_secret: 'cs' }; db.setupIntents.set(id, si); return si; },
    retrieve: async (id) => db.setupIntents.get(id),
  },
  subscriptions: { list: async () => ({ data: [] }), create: async (o) => ({ id: 'sub_1', status: 'active', ...o }) },
  promotionCodes: { list: async () => ({ data: [] }) },
};
stripeMock.customers.search = async () => ({ data: [...db.customers.values()], has_more: false });
const origRequire = Module.prototype.require;
Module.prototype.require = function (m) { if (m === 'stripe') return function () { return stripeMock; }; return origRequire.apply(this, arguments); };
// Silence outbound side effects
const mail = require('../lib/mail'); mail.sendSignupEmails = async () => ({ retailer: { id: 'mail_1' } });
const of = require('../lib/orderform'); of.buildOrderForm = async () => Buffer.from('%PDF');
const core = require('../lib/core'); core.notifyCore = async () => ({ skipped: true });

const setupIntent = require('../api/setup-intent');
const accept = require('../api/accept');
const lead = require('../api/lead');
const links = require('../api/links');
const coreExport = require('../api/core-export');
const orderform = require('../api/orderform');
const config = require('../lib/config');
const sec = require('../lib/security');

function call(handler, { method = 'POST', body, headers = {}, query = {} } = {}) {
  const res = { headers: {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, send(b) { this.body = b; return this; }, setHeader(k, v) { this.headers[k] = v; } };
  const req = { method, headers: { origin: 'https://onboarding.poof.ca', 'x-forwarded-for': headers.ip || '1.1.1.1', ...headers }, body: body ? JSON.stringify(body) : undefined, query, socket: {} };
  return handler(req, res).then(() => res);
}

const goodBody = () => ({
  store: { chain: 'sessions-cannabis', chainName: 'Sessions Cannabis', agcoName: 'Sessions Cannabis', extra: [], overrides: {} },
  entryStoreId: 'CRSA1537578', locations: ['CRSA1537578', 'CRSA1537578'], groups: [],
  systems: { pos: 'Greenline', processor: 'Merrco', ecommerce: 'Breadstack', delivery: true, deliverySoftware: 'Canfleet' },
  owner: { name: 'Test Owner', email: 'owner@example.com', mobile: '4165550100' }, referral: null,
});

test('setup-intent: creates customer, dedupes licences, returns session token', async () => {
  const r = await call(setupIntent, { body: goodBody() });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(r.body.locations.length, 1, 'duplicate CRSA collapsed');
  assert.match(r.body.session, /^[0-9a-f]{64}$/);
});

test('setup-intent: rejects garbage input (type/length/email)', async () => {
  const b = goodBody(); b.owner.email = 'not-an-email'; b.systems.pos = 'x'.repeat(61); b.owner.name = 'x'.repeat(500);
  const r = await call(setupIntent, { body: b });
  assert.equal(r.code, 400);
  assert.ok(r.body.fields.includes('owner.email') && r.body.fields.includes('systems.pos') && r.body.fields.includes('owner.name'));
});

test('S1: update with a known cus_ id but no/forged session is refused', async () => {
  const first = await call(setupIntent, { body: goodBody() });
  const b = goodBody(); b.customerId = first.body.customerId; b.owner.email = 'attacker@example.com';
  const noTok = await call(setupIntent, { body: b });
  assert.equal(noTok.code, 403);
  b.session = 'f'.repeat(64);
  const forged = await call(setupIntent, { body: b });
  assert.equal(forged.code, 403);
  const c = await stripeMock.customers.retrieve(first.body.customerId);
  assert.equal(c.email, 'owner@example.com', 'email unchanged');
  b.session = first.body.session;
  const legit = await call(setupIntent, { body: b });
  assert.equal(legit.code, 200);
});

test('S1: accept requires session; is write-once; replay is idempotent', async () => {
  const si = await call(setupIntent, { body: goodBody() });
  const base = { customerId: si.body.customerId, setupIntentId: si.body.setupIntentId, acceptance: { name: 'Test Owner', title: 'Owner', agreed: true, authorised: true } };
  assert.equal((await call(accept, { body: base })).code, 403, 'no session');
  assert.equal((await call(accept, { body: { ...base, session: 'a'.repeat(64) } })).code, 403, 'forged session');
  const ok = await call(accept, { body: { ...base, session: si.body.session } });
  assert.equal(ok.code, 200, JSON.stringify(ok.body));
  const firstAt = ok.body.acceptedAt;
  // Replay of the same acceptance → same result, nothing rewritten
  const again = await call(accept, { body: { ...base, session: si.body.session } });
  assert.equal(again.code, 200); assert.equal(again.body.acceptedAt, firstAt); assert.equal(again.body.replay, true);
  // Attempt to re-accept with different details (card skipped) → refused
  const tamper = await call(accept, { body: { ...base, cardSkipped: true, setupIntentId: undefined, acceptance: { name: 'Mallory', title: 'CEO', agreed: true, authorised: true }, session: si.body.session } });
  assert.equal(tamper.code, 409);
  // And setup-intent can no longer reset an accepted record
  const reset = await call(setupIntent, { body: { ...goodBody(), customerId: si.body.customerId, session: si.body.session } });
  assert.equal(reset.code, 409);
});

test('S2: lead is rate-limited per IP and per email; completed/agreement need a session', async () => {
  let last;
  for (let i = 0; i < 10; i++) last = await call(lead, { body: { email: `u${i}@example.com`, stage: 'started' }, headers: { ip: '9.9.9.9' } });
  assert.equal(last.code, 429);
  const fake = await call(lead, { body: { email: 'victim@example.com', stage: 'completed', customerId: 'cus_test1' }, headers: { ip: '8.8.8.8' } });
  assert.equal(fake.code, 403, 'cannot fake a completion without the session');
  const bot = await call(lead, { body: { email: 'bot@example.com', stage: 'started', website: 'http://spam' }, headers: { ip: '7.7.7.7' } });
  assert.equal(bot.code, 200); assert.equal(bot.body.resumeUrl, undefined, 'honeypot swallowed silently');
});

test('S3: admin key only via header, constant-time; query string ignored', async () => {
  assert.equal((await call(links, { method: 'GET', query: { key: 'admin-test-key' } })).code, 401);
  assert.equal((await call(coreExport, { method: 'GET', query: { key: 'admin-test-key' } })).code, 401);
  assert.equal((await call(links, { method: 'GET', headers: { 'x-admin-key': 'admin-test-kez' } })).code, 401);
  assert.equal((await call(links, { method: 'GET', headers: { 'x-admin-key': 'admin-test-key' } })).code, 200);
});

test('S4: order-form token is bound to customer, full-length, and expires', async () => {
  const si = await call(setupIntent, { body: goodBody() });
  await call(accept, { body: { customerId: si.body.customerId, setupIntentId: si.body.setupIntentId, acceptance: { name: 'A', title: 'B', agreed: true, authorised: true }, session: si.body.session } });
  const good = config.orderFormToken(si.body.customerId);
  assert.equal((await call(orderform, { method: 'GET', query: { c: si.body.customerId, t: good } })).code, 200);
  assert.equal((await call(orderform, { method: 'GET', query: { c: 'cus_other', t: good } })).code, 403, 'token bound to customer');
  const [exp, sig] = good.split('.');
  assert.equal((await call(orderform, { method: 'GET', query: { c: si.body.customerId, t: `${Number(exp) + 1}.${sig}` } })).code, 403, 'expiry is signed');
  assert.equal((await call(orderform, { method: 'GET', query: { c: si.body.customerId, t: `${Date.now() - 1000}.${config.sign(`${si.body.customerId}:${Date.now() - 1000}`, 'orderform')}` } })).code, 403, 'expired');
});

test('S4: resume token tamper is rejected; sign() is purpose-bound', async () => {
  const tok = config.encodeResume({ c: 'sessions-cannabis', s: ['CRSA1537578'], t: Date.now() });
  assert.ok(config.decodeResume(tok));
  const [b, s] = tok.split('.');
  assert.equal(config.decodeResume(Buffer.from(JSON.stringify({ c: 'canna-cabana', t: Date.now() })).toString('base64url') + '.' + s), null);
  assert.notEqual(config.sign('x', 'link'), config.sign('x', 'orderform'));
  assert.equal(sec.sessionToken('cus_a') === sec.sessionToken('cus_b'), false);
});

test('S9: cross-origin POST is refused', async () => {
  const r = await call(setupIntent, { body: goodBody(), headers: { origin: 'https://evil.example' } });
  assert.equal(r.code, 403);
});

test('production refuses to run without SIGNING_SECRET', () => {
  const saved = process.env.SIGNING_SECRET; delete process.env.SIGNING_SECRET;
  assert.throws(() => config.signingSecret(), /SIGNING_SECRET/);
  process.env.SIGNING_SECRET = saved;
});

// ---- Added after second audit -------------------------------------------------

test('C0 regression: "Other" free-text systems are accepted', async () => {
  const b = goodBody(); b.systems = { pos: 'Square', processor: 'Helcim', ecommerce: 'Shopify', delivery: true, deliverySoftware: 'Trexity' };
  const r = await call(setupIntent, { body: b });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  const c = await stripeMock.customers.retrieve(r.body.customerId);
  assert.equal(c.metadata.pos, 'Square');
});

test('S2: lead per-email limit trips independently of IP; agreement stage allowed pre-customer', async () => {
  let last;
  for (let i = 0; i < 14; i++) last = await call(lead, { body: { email: 'same@example.com', stage: 'locations', chain: 'sessions-cannabis' }, headers: { ip: `10.0.0.${i}` } });
  assert.equal(last.code, 429);
  const ag = await call(lead, { body: { email: 'agree@example.com', stage: 'agreement', chain: 'sessions-cannabis' }, headers: { ip: '10.1.1.1' } });
  assert.equal(ag.code, 200);
});

test('S9: origin handling — malformed Referer, null origin, Referer-only, preview hosts', async () => {
  assert.notEqual((await call(setupIntent, { body: goodBody(), headers: { origin: undefined, referer: 'not a url' } })).code, 500, 'malformed referer must not 500');
  assert.equal((await call(setupIntent, { body: goodBody(), headers: { origin: 'null', referer: 'https://evil.example/x' } })).code, 403);
  assert.equal((await call(setupIntent, { body: goodBody(), headers: { origin: undefined, referer: 'https://evil.example/x' } })).code, 403);
  assert.equal((await call(setupIntent, { body: goodBody(), headers: { origin: 'https://poofonboarding-abc123-bizzy30ks-projects.vercel.app' } })).code, 200);
  assert.equal((await call(setupIntent, { body: goodBody(), headers: { origin: 'https://poof-onboarding.vercel.app' } })).code, 200);
});

test('S3: admin compare uses timingSafeEqual (not ===)', () => {
  const src = require('fs').readFileSync(require.resolve('../lib/security'), 'utf8');
  assert.match(src, /timingSafeEqual/);
  assert.ok(!/key\s*===\s*config\.ADMIN_KEY/.test(src));
  assert.equal(sec.safeEqual('abc', 'abc'), true); assert.equal(sec.safeEqual('abc', 'abd'), false); assert.equal(sec.safeEqual('abc', 'abcd'), false);
});

test('C3: a retailer\'s own earlier attempt is not a franchise conflict; a rival is', async () => {
  const { findConflicts } = require('../lib/conflicts');
  const a = await call(setupIntent, { body: goodBody() });
  const b = await call(setupIntent, { body: goodBody() }); // same owner email, same door
  const g1 = await findConflicts(stripeMock, ['CRSA1537578'], b.body.customerId, 'owner@example.com');
  assert.equal(g1.ok, true); assert.equal(g1.conflicts.some(c => c.customerId === a.body.customerId), false);
  const rival = goodBody(); rival.owner.email = 'rival@example.com';
  const r = await call(setupIntent, { body: rival });
  const g2 = await findConflicts(stripeMock, ['CRSA1537578'], r.body.customerId, 'rival@example.com');
  assert.ok(g2.conflicts.length >= 1);
  assert.equal(g2.conflicts[0].email, undefined, 'no cross-customer email stored');
});

test('M7: prototype-key slugs do not crash store lookups', () => {
  const stores = require('../lib/stores');
  assert.equal(stores.chain('constructor'), undefined);
  assert.equal(stores.store('__proto__'), undefined);
});

test('C2: metadata budget — 50-door chain with many groups fits under 50 keys', () => {
  const record = require('../lib/record');
  const stores = require('../lib/stores');
  const sessions = stores.chain('sessions-cannabis');
  const locs = sessions.stores.map(s => ({ id: s.id }));
  const groups = Array.from({ length: 20 }, (_, i) => ({ name: `Region ${i}`, ids: locs.slice(i * 2, i * 2 + 3).map(l => l.id) }));
  const rec = { store: { chain: 'sessions-cannabis', chainName: 'Sessions Cannabis' }, locations: locs, groups, systems: { pos: 'Cova' }, owner: { name: 'A B', email: 'a@b.co' }, acceptance: { name: 'A B', title: 'Owner', at: new Date().toISOString(), termsHash: 'x'.repeat(64) },
    conflicts: Array.from({ length: 5 }, (_, i) => ({ customerId: `cus_${i}`, stage: 'Live', overlap: locs.slice(0, 50).map(l => l.id) })) };
  const meta = record.pack(rec);
  assert.ok(Object.keys(meta).length + 4 <= 50, `keys=${Object.keys(meta).length}`); // +3 accept keys +1 activate key
});

test('PDF: non-WinAnsi characters do not crash the order form', async () => {
  const real = origRequire.call(module, '../lib/orderform');
  // reload the un-stubbed module
  delete require.cache[require.resolve('../lib/orderform')];
  const { buildOrderForm } = require('../lib/orderform');
  const stores = require('../lib/stores'); const s = stores.store('CRSA1537578');
  const rec = { store: { chain: 'sessions-cannabis', chainName: 'Sessions 🌿 Cannabis' }, locations: [s], groups: [], systems: { pos: 'Cova' }, owner: { name: 'Nguyễn Văn A', email: 'a@b.co', mobile: '' }, referral: null,
    acceptance: { name: 'Nguyễn Văn A', title: 'Propriétaire', at: new Date().toISOString(), ip: '1.1.1.1', termsVersion: '2026-08-15', termsUrl: 'https://business.poof.ca/terms', termsHash: 'abc', locationCount: 1 }, customerId: 'cus_pdf' };
  const pdf = await buildOrderForm(rec);
  assert.ok(Buffer.isBuffer(pdf) || pdf instanceof Uint8Array); assert.ok(pdf.length > 1000);
});

test('Turnstile: enforced on first customer creation and lead(started) when configured; updates with session exempt', async () => {
  const cfg = require('../lib/config');
  // Not configured → passes (dev/preview)
  assert.equal((await call(setupIntent, { body: goodBody(), headers: { ip: '6.0.0.1' } })).code, 200);
  // Configure and stub the verifier's network call
  cfg.TURNSTILE_SECRET_KEY = 'secret';
  const origFetchT = sec.fetchT;
  const results = { 'good-token': { success: true }, 'bad-token': { success: false, 'error-codes': ['invalid-input-response'] } };
  const secMod = require('../lib/security');
  const realVerify = secMod.verifyTurnstile;
  // Monkeypatch global fetch used by fetchT
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => { const b = JSON.parse(opts.body); return { json: async () => results[b.response] || { success: false, 'error-codes': ['missing-input-response'] } }; };
  try {
    assert.equal((await call(setupIntent, { body: goodBody(), headers: { ip: '6.0.0.2' } })).code, 403, 'no token → refused');
    assert.equal((await call(setupIntent, { body: { ...goodBody(), turnstile: 'bad-token' }, headers: { ip: '6.0.0.3' } })).code, 403, 'bad token → refused');
    const ok = await call(setupIntent, { body: { ...goodBody(), turnstile: 'good-token' }, headers: { ip: '6.0.0.4' } });
    assert.equal(ok.code, 200, JSON.stringify(ok.body));
    // Session-authenticated update needs no new token
    const upd = await call(setupIntent, { body: { ...goodBody(), customerId: ok.body.customerId, session: ok.body.session }, headers: { ip: '6.0.0.5' } });
    assert.equal(upd.code, 200);
    // lead(started) refused without token, other stages unaffected
    assert.equal((await call(lead, { body: { email: 'ts@example.com', stage: 'started', chain: 'sessions-cannabis' }, headers: { ip: '5.5.5.5' } })).code, 403);
    assert.equal((await call(lead, { body: { email: 'ts@example.com', stage: 'started', chain: 'sessions-cannabis', turnstile: 'good-token' }, headers: { ip: '5.5.5.6' } })).code, 200);
    assert.equal((await call(lead, { body: { email: 'ts@example.com', stage: 'locations', chain: 'sessions-cannabis' }, headers: { ip: '5.5.5.7' } })).code, 200);
    // Verifier outage → degrades open (does not lock retailers out)
    global.fetch = async () => { throw new Error('ECONNRESET'); };
    assert.equal((await call(setupIntent, { body: { ...goodBody(), turnstile: 'whatever' }, headers: { ip: '6.0.0.6' } })).code, 200);
  } finally { global.fetch = realFetch; cfg.TURNSTILE_SECRET_KEY = undefined; }
});

test('setup-intent: one Stripe customer per email — unfinished signup is reused, finished one blocks a second', async () => {
  db.listByEmail = true;
  try {
    const body = () => ({ ...goodBody(), owner: { ...goodBody().owner, email: 'one@percustomer.ca' } });
    const a = await call(setupIntent, { body: body() });
    const b = await call(setupIntent, { body: body() });
    assert.equal(a.code, 200); assert.equal(b.code, 200);
    assert.equal(a.body.customerId, b.body.customerId, 'restarted signup reuses the customer');
    const ok = await call(accept, { body: { customerId: b.body.customerId, setupIntentId: b.body.setupIntentId, session: b.body.session, acceptance: { name: 'Test Owner', title: 'Owner', agreed: true, authorised: true } } });
    assert.equal(ok.code, 200, JSON.stringify(ok.body));
    const c = await call(setupIntent, { body: body() });
    assert.equal(c.code, 409); assert.equal(c.body.code, 'email_exists'); assert.match(c.body.error, /already has a Poof signup/);
  } finally { db.listByEmail = false; }
});
