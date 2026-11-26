// signup.poof.ca (one-page signup, project poof-activate) drives this API through a rewrite.
// These tests send exactly what that page sends and cover the discount lock. Run: node --test test/
const { test } = require('node:test');
const assert = require('node:assert');
const Module = require('module');

process.env.SIGNING_SECRET = 'test-signing-secret-at-least-32-chars-long-ok';
process.env.STRIPE_SECRET_KEY = 'sk_test_x';
process.env.ADMIN_KEY = 'admin-test-key';
process.env.SITE_URL = 'https://onboarding.poof.ca';
process.env.VERCEL_ENV = 'production';
process.env.CORE_API_DISABLED = '1';

const COUPON = { id: 'coup_6mo', percent_off: 100, duration: 'repeating', duration_in_months: 6, valid: true };
const db = { customers: new Map(), setupIntents: new Map(), subs: [], promoActive: true };
let nextId = 1;
const stripeMock = {
  customers: {
    create: async (o) => { const id = `cus_page${nextId++}`; const c = { id, ...o, metadata: { ...o.metadata }, invoice_settings: {} }; db.customers.set(id, c); return c; },
    retrieve: async (id) => { const c = db.customers.get(id); if (!c) throw new Error('No such customer'); return c; },
    update: async (id, o) => { const c = db.customers.get(id); Object.assign(c, o, { metadata: { ...c.metadata, ...(o.metadata || {}) }, invoice_settings: { ...c.invoice_settings, ...(o.invoice_settings || {}) } }); return c; },
    search: async () => ({ data: [...db.customers.values()], has_more: false }),
    list: async ({ email }) => ({ data: [...db.customers.values()].filter(c => c.email === email) }),
  },
  paymentMethods: { retrieve: async () => ({ id: 'pm_x', billing_details: { name: 'Dana Lee', email: 'dana@store.ca', address: { line1: '12 Billing St', city: 'Toronto', state: 'ON', postal_code: 'M5V 1A1', country: 'CA' } } }) },
  setupIntents: {
    create: async (o) => { const id = `seti_${nextId++}`; const si = { id, customer: o.customer, status: 'succeeded', payment_method: 'pm_x', client_secret: 'cs' }; db.setupIntents.set(id, si); return si; },
    retrieve: async (id) => db.setupIntents.get(id),
  },
  subscriptions: { list: async () => ({ data: [] }), create: async (o) => { db.subs.push(o); return { id: 'sub_1', status: 'active', ...o }; } },
  promotionCodes: { list: async ({ code }) => ({ data: db.promoActive && code === 'POOF180' ? [{ id: 'promo_180', code: 'POOF180', coupon: COUPON }] : [] }) },
  coupons: { retrieve: async (id) => { if (id !== COUPON.id) throw new Error('No such coupon'); return COUPON; } },
};
const origRequire = Module.prototype.require;
Module.prototype.require = function (m) { if (m === 'stripe') return function () { return stripeMock; }; return origRequire.apply(this, arguments); };
const mail = require('../lib/mail'); let lastMail = null; mail.sendSignupEmails = async (rec) => { lastMail = rec; return { retailer: { id: 'mail_1' } }; };
const of = require('../lib/orderform'); of.buildOrderForm = async () => Buffer.from('%PDF');
const core = require('../lib/core'); core.notifyCore = async () => ({ skipped: true });

const setupIntent = require('../api/setup-intent');
const accept = require('../api/accept');
const activate = require('../api/activate');
const promoApi = require('../api/promo');
const record = require('../lib/record');
const promo = require('../lib/promo');
const sec = require('../lib/security');

function call(handler, { method = 'POST', body, headers = {}, query = {} } = {}) {
  const res = { headers: {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, send(b) { this.body = b; return this; }, setHeader(k, v) { this.headers[k] = v; } };
  const req = { method, headers: { origin: 'https://signup.poof.ca', 'x-forwarded-for': headers.ip || '2.2.2.2', ...headers }, body: body ? JSON.stringify(body) : undefined, query, socket: {} };
  return handler(req, res).then(() => res);
}

// Exactly the body the one-page form posts.
const pageBody = (email, code, st = { chain: 'sessions-cannabis', name: 'Sessions Cannabis', id: 'CRSA1537578' }) => ({
  store: { chain: st.chain, chainName: st.name, agcoName: '', extra: [], overrides: {} },
  entryStoreId: st.id, locations: [st.id], groups: [],
  systems: { pos: 'Greenline', processor: 'Merrco', ecommerce: '', delivery: null, deliverySoftware: '' },
  owner: { name: 'Dana Lee', email, mobile: '' }, referral: code ? { code } : null,
  source: 'signup.poof.ca', turnstile: null,
});
const cfg = require('../lib/config');
// The code-based tests below cover the discount-code machinery, which signup.poof.ca only uses when the tiered offer is off.
const signUpWithCode = async (...a) => { cfg.SIGNUP_OFFER.enabled = false; try { return await signUp(...a); } finally { cfg.SIGNUP_OFFER.enabled = true; } };
const signUp = async (email, code, st, skipCard) => {
  const si = await call(setupIntent, { body: pageBody(email, code, st) });
  assert.equal(si.code, 200, JSON.stringify(si.body));
  const acc = await call(accept, { body: { customerId: si.body.customerId, session: si.body.session, ...(skipCard ? { cardSkipped: true } : { setupIntentId: si.body.setupIntentId, cardSkipped: false }), acceptance: { name: 'Dana Lee', title: 'Owner', agreed: true, authorised: true } } });
  assert.equal(acc.code, 200, JSON.stringify(acc.body));
  return si.body;
};

test('normCode: spaces and case never matter', () => {
  assert.equal(promo.normCode(' poof 180 '), 'POOF180');
  assert.equal(promo.normCode('Poof180'), 'POOF180');
  assert.equal(promo.normCode(null), '');
});

test('same-origin: signup.poof.ca and its previews are allowed, look-alikes are not', () => {
  const ok = (origin) => sec.sameOrigin({ headers: { origin } });
  assert.equal(ok('https://signup.poof.ca'), true);
  assert.equal(ok('https://poof-activate-abc123-bizzy30ks-projects.vercel.app'), true);
  assert.equal(ok('https://signup.poof.ca.evil.example'), false);
  assert.equal(ok('https://poof-activate.evil.example'), false);
});

test('promo: "POOF 180" validates and reports 6 months free', async () => {
  const r = await call(promoApi, { method: 'GET', query: { code: 'poof 180' } });
  assert.equal(r.body.valid, true);
  assert.equal(r.body.code, 'POOF180');
  assert.equal(r.body.months, 6);
  assert.equal(r.body.description, '6 months free');
});

test('one-page signup: record, discount lock, acceptance and email all land', async () => {
  const s = await signUpWithCode('dana@store.ca', 'poof 180');
  assert.deepEqual(s.referral, { code: 'POOF180', description: '6 months free', months: 6, days: null, until: null });
  const c = db.customers.get(s.customerId);
  const rec = record.unpack(c.metadata);
  assert.equal(rec.referral.couponId, 'coup_6mo');
  assert.equal(rec.source, 'signup.poof.ca');
  assert.equal(c.metadata.source, 'onboarding.poof.ca', 'franchise guard / export key unchanged');
  assert.equal(c.metadata.referral_code, 'POOF180 — 6 months free');
  assert.match(c.description, /via signup\.poof\.ca/);
  assert.equal(c.metadata.card_on_file, 'yes');
  assert.equal(c.address.line1, '12 Billing St', 'billing address from the card, not the store');
  assert.equal(lastMail.referral.months, 6);
  assert.ok(Object.keys(c.metadata).length <= 50, 'Stripe metadata cap');
});

test('activation: active code is applied as a promotion code', async () => {
  const s = await signUpWithCode('active@store.ca', 'POOF180');
  db.subs.length = 0;
  const r = await call(activate, { body: { customerId: s.customerId }, headers: { 'x-admin-key': 'admin-test-key' } });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(db.subs[0].promotion_code, 'promo_180');
  assert.equal(r.body.promo, 'POOF180');
});

test('activation: code switched off after the webinar still gives the locked 6 months', async () => {
  const s = await signUpWithCode('later@store.ca', 'POOF180', { chain: '1-stop-cannabis', name: '1 Stop Cannabis', id: 'CRSA1250792' });
  db.promoActive = false; db.subs.length = 0;
  const r = await call(activate, { body: { customerId: s.customerId }, headers: { 'x-admin-key': 'admin-test-key' } });
  db.promoActive = true;
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.deepEqual(db.subs[0].discounts, [{ coupon: 'coup_6mo' }]);
  assert.equal(db.subs[0].promotion_code, undefined);
  assert.equal(r.body.promo, 'POOF180');
  assert.match(r.body.promoSource, /locked/);
});

test('second signup under the same email is refused with a clear message', async () => {
  const r = await call(setupIntent, { body: pageBody('dana@store.ca', null) });
  assert.equal(r.code, 409);
  assert.equal(r.body.code, 'email_exists');
});

test('grouped picker: a second banner and a named group are stored', async () => {
  const b = pageBody('group@store.ca', null);
  b.store.extra = ['1-stop-cannabis']; b.entryStoreId = null;
  b.locations = ['CRSA1537578', 'CRSA1250792'];
  b.groups = [{ name: 'Windsor-Essex', ids: ['CRSA1537578', 'CRSA1250792'] }];
  const r = await call(setupIntent, { body: b });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  const rec = record.unpack(db.customers.get(r.body.customerId).metadata);
  assert.equal(rec.locations.length, 2);
  assert.deepEqual(rec.store.extra, ['1-stop-cannabis']);
  assert.equal(rec.groups[0].name, 'Windsor-Essex');
  assert.equal(db.customers.get(r.body.customerId).metadata.groups, 'Windsor-Essex:2');
});

// ---- POOF180-style code: fixed free period from go-live with a hard end date ----
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
const withTerms = async (until, fn) => {
  const saved = COUPON.metadata; COUPON.metadata = { free_days: '180', ...(until ? { free_until: until } : {}) };
  try { await fn(); } finally { COUPON.metadata = saved; }
};

test('free period: code check reports 180 days and the end date', async () => {
  await withTerms('2027-06-30', async () => {
    const r = await call(promoApi, { method: 'GET', query: { code: 'POOF 180' } });
    assert.equal(r.body.description, '180 days free');
    assert.equal(r.body.days, 180); assert.equal(r.body.until, '2027-06-30'); assert.equal(r.body.months, null);
  });
});

test('free period: go-live well before the end date gets the full 180 days as a trial, no coupon', async () => {
  await withTerms(ymd(Date.now() + 400 * 86400e3), async () => {
    const s = await signUpWithCode('days@store.ca', 'POOF180', { chain: 'take-off-cannabis', name: 'Take Off Cannabis', id: 'CRSA1574722' });
    db.subs.length = 0;
    const r = await call(activate, { body: { customerId: s.customerId }, headers: { 'x-admin-key': 'admin-test-key' } });
    assert.equal(r.code, 200, JSON.stringify(r.body));
    const want = Math.floor((Date.now() + 180 * 86400e3) / 1000);
    assert.ok(Math.abs(db.subs[0].trial_end - want) < 120, 'trial ends 180 days out');
    assert.equal(db.subs[0].promotion_code, undefined); assert.equal(db.subs[0].discounts, undefined);
    assert.equal(r.body.promo, 'POOF180'); assert.ok(r.body.freeUntil);
  });
});

test('free period: go-live close to the end date is capped at that date, even if the code is off by then', async () => {
  const until = ymd(Date.now() + 30 * 86400e3);
  await withTerms(until, async () => {
    const s = await signUpWithCode('cap@store.ca', 'POOF180', { chain: 'shiny-vapes-cannabis', name: 'Shiny Vapes & Cannabis', id: 'CRSA1509400' });
    db.promoActive = false; db.subs.length = 0;
    const r = await call(activate, { body: { customerId: s.customerId }, headers: { 'x-admin-key': 'admin-test-key' } });
    db.promoActive = true;
    assert.equal(r.code, 200, JSON.stringify(r.body));
    assert.equal(db.subs[0].trial_end, Math.floor(Date.parse(until + 'T23:59:59-05:00') / 1000));
    assert.equal(db.subs[0].discounts, undefined, 'the locked coupon is not stacked on the trial');
    assert.match(r.body.promoSource, /locked/);
  });
});

test('free period: a store that goes live after the end date pays from day one', () => {
  assert.equal(promo.trialEnd({ days: 180, until: '2020-01-01' }), null);
  assert.equal(promo.longDate('2027-06-30'), 'June 30, 2027');
});

// ---- signup.poof.ca offer (2026-11-26): card at signup = free until June 30, 2027; no card = free until March 31, 2027 ----
const offers = require('../lib/offer');
const admin = { 'x-admin-key': 'admin-test-key' };
test('tiered offer: a card at signup is free until June 30, 2027, and a typed code changes nothing', async () => {
  const s = await signUp('card@tier.ca', 'POOF180', { chain: "blyth-cannabis", name: "Blyth Cannabis", id: "CRSA1502480" });
  const rec = record.unpack(db.customers.get(s.customerId).metadata);
  assert.deepEqual({ tier: rec.offer.tier, until: rec.offer.until, months: rec.offer.months }, { tier: 'card', until: '2027-06-30', months: 6 });
  assert.equal(rec.referral, null, 'no code is needed, and a code does not stack');
  assert.match(offers.lines(rec.offer).headline, /No charge until June 30, 2027/);
  assert.match(offers.lines(rec.offer).billingStarts, /^July 1, 2027/);
  db.subs.length = 0;
  const r = await call(activate, { body: { customerId: s.customerId }, headers: admin });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(db.subs[0].trial_end, Math.floor(Date.parse('2027-06-30T23:59:59-05:00') / 1000));
  assert.equal(db.subs[0].default_payment_method, 'pm_x'); assert.equal(db.subs[0].promotion_code, undefined); assert.equal(db.subs[0].discounts, undefined);
});
test('tiered offer: no card at signup is free until March 31, 2027 and can still go live inside that window', async () => {
  const s = await signUp('nocard@tier.ca', null, { chain: "bongbaba-cannabis-culture", name: "Bongbaba Cannabis Culture", id: "CRSA1210605" }, true);
  const c = db.customers.get(s.customerId), rec = record.unpack(c.metadata);
  assert.deepEqual({ tier: rec.offer.tier, until: rec.offer.until, skipped: rec.cardSkipped }, { tier: 'nocard', until: '2027-03-31', skipped: true });
  assert.match(c.metadata.card_on_file, /^no/);
  assert.match(offers.lines(rec.offer).detail, /A card must be added before March 31, 2027/);
  db.subs.length = 0;
  const r = await call(activate, { body: { customerId: s.customerId }, headers: admin });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(db.subs[0].trial_end, Math.floor(Date.parse('2027-03-31T23:59:59-05:00') / 1000));
  assert.equal(db.subs[0].default_payment_method, undefined);
  assert.deepEqual(db.subs[0].trial_settings, { end_behavior: { missing_payment_method: 'pause' } });
});
test('tiered offer: once the free period has passed, a store with no card cannot be switched on', async () => {
  const s = await signUp('late@tier.ca', null, { chain: "borderland-cannabis", name: "Borderland Cannabis", id: "CRSA1195753" }, true);
  const c = db.customers.get(s.customerId), rec = record.unpack(c.metadata);
  rec.offer.until = '2026-01-31'; Object.assign(c.metadata, record.pack(rec, record.chunksIn(c.metadata)));
  const r = await call(activate, { body: { customerId: s.customerId }, headers: admin });
  assert.equal(r.code, 400); assert.match(r.body.error, /free period has ended/);
});
