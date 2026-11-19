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
const signUp = async (email, code, st) => {
  const si = await call(setupIntent, { body: pageBody(email, code, st) });
  assert.equal(si.code, 200, JSON.stringify(si.body));
  const acc = await call(accept, { body: { customerId: si.body.customerId, session: si.body.session, setupIntentId: si.body.setupIntentId, cardSkipped: false, acceptance: { name: 'Dana Lee', title: 'Owner', agreed: true, authorised: true } } });
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
  const s = await signUp('dana@store.ca', 'poof 180');
  assert.deepEqual(s.referral, { code: 'POOF180', description: '6 months free', months: 6 });
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
  const s = await signUp('active@store.ca', 'POOF180');
  db.subs.length = 0;
  const r = await call(activate, { body: { customerId: s.customerId }, headers: { 'x-admin-key': 'admin-test-key' } });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(db.subs[0].promotion_code, 'promo_180');
  assert.equal(r.body.promo, 'POOF180');
});

test('activation: code switched off after the webinar still gives the locked 6 months', async () => {
  const s = await signUp('later@store.ca', 'POOF180', { chain: '1-stop-cannabis', name: '1 Stop Cannabis', id: 'CRSA1250792' });
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
