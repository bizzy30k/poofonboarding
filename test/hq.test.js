// lib/hq.js — read-only Poof HQ lookup, exercised against a mocked core API.
const test = require('node:test');
const assert = require('node:assert');
process.env.CORE_API_KEY = 'test-key';
const hq = require('../lib/hq');

const row = (over = {}) => ({ id: '6a933bae02d36c993be88b5a', slug: 'weedjar-809-yonge-st-toronto', name: 'Weedjar', displayAs: 'Weedjar', licenseNumber: 'CRSA1254817', location: { address: '809 Yonge St', postalCode: 'M4W 2G9', city: 'Toronto' }, isValidated: false, owner: null, ...over });
const agco = { id: 'CRSA1254817', name: 'WEEDJAR', addr: '809 YONGE ST', city: 'TORONTO', postal: 'M4W 2G9', chainName: 'Weedjar' };

let calls = [];
const realFetch = global.fetch;
test.beforeEach(() => { calls = []; hq._reset(); });
test.after(() => { global.fetch = realFetch; });
function mock(handler) { global.fetch = async (url, opts) => { calls.push({ url: String(url), headers: opts.headers }); const r = handler(String(url)); return { ok: r.status ? r.status < 400 : true, status: r.status || 200, json: async () => r.body }; }; }

test('matches by licence number and keeps the HQ id, slug and url', async () => {
  mock(() => ({ body: { data: [row()] } }));
  const m = await hq.match(agco);
  assert.deepStrictEqual(m, { id: '6a933bae02d36c993be88b5a', slug: 'weedjar-809-yonge-st-toronto', name: 'Weedjar', url: 'https://hq.poof.ca/store/6a933bae02d36c993be88b5a', matched: 'licence', owner: null, validated: false });
  assert.match(calls[0].url, /\/admin\/store\/list-unclaimed\?unclaimed=true&count=500&search=weedjar$/);
  assert.strictEqual(calls[0].headers.authorization, 'Bearer test-key');
});

test('falls back to postal + street number + name when core has no licence on the row', async () => {
  mock(() => ({ body: [row({ licenseNumber: null, id: 'abc123' })] }));
  const m = await hq.match(agco);
  assert.strictEqual(m.id, 'abc123'); assert.strictEqual(m.matched, 'address');
});

test('no match when the address differs; core outage → null, never throws', async () => {
  mock(() => ({ body: [row({ licenseNumber: null, location: { address: '12 Bloor St', postalCode: 'M4W 2G9' } })] }));
  assert.strictEqual(await hq.match(agco), null);
  hq._reset(); mock(() => ({ status: 500, body: {} }));
  assert.strictEqual(await hq.match(agco), null);
  hq._reset(); global.fetch = async () => { throw new Error('boom'); };
  assert.strictEqual(await hq.match(agco), null);
});

test('one chain = one core request (cached), and a second store on the chain matches from the cache', async () => {
  mock(() => ({ body: [row(), row({ id: 'other', licenseNumber: 'CRSA1111111', location: { address: '1 King St', postalCode: 'M5H 1A1' } })] }));
  await hq.match(agco);
  const m2 = await hq.match({ id: 'CRSA1111111', name: 'WEEDJAR', addr: '1 KING ST', postal: 'M5H 1A1', chainName: 'Weedjar' });
  assert.strictEqual(m2.id, 'other'); assert.strictEqual(calls.length, 1);
});

test('Stripe metadata: one hq_<CRSA> key per matched location + a summary, capped', () => {
  const map = { CRSA1: { id: 'a', url: 'https://hq.poof.ca/store/a' }, CRSA2: null, CRSA3: { id: 'c', url: 'https://hq.poof.ca/store/c' } };
  assert.deepStrictEqual(hq.stripeMeta(map, 1), { hq_CRSA1: 'https://hq.poof.ca/store/a', hq_store_ids: 'CRSA1=a CRSA3=c' });
});

test('no key → no auth header; CORE_API_DISABLED switches the lookup off', async () => {
  delete process.env.CORE_API_KEY; mock(() => ({ body: [] })); await hq.search('zzz');
  assert.deepStrictEqual(Object.keys(calls[0].headers), ['accept']);
  process.env.CORE_API_DISABLED = '1'; hq._reset(); assert.strictEqual(await hq.match(agco), null); assert.strictEqual(calls.length, 1);
  delete process.env.CORE_API_DISABLED; process.env.CORE_API_KEY = 'test-key';
});

test('auth schemes: x-api-key and custom header', async () => {
  process.env.CORE_API_AUTH = 'x-api-key'; mock(() => ({ body: [] })); await hq.search('zzz');
  assert.strictEqual(calls[0].headers['x-api-key'], 'test-key');
  hq._reset(); process.env.CORE_API_AUTH = 'header:x-admin-token'; await hq.search('zzz');
  assert.strictEqual(calls[1].headers['x-admin-token'], 'test-key');
  process.env.CORE_API_AUTH = 'bearer';
});
