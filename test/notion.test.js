const test = require('node:test'); const assert = require('node:assert');
process.env.NOTION_TOKEN = 'ntn_test';
const sec = require('../lib/security');
const calls = [];
let rows = {}, accounts = {}, logged = false;
const ACCOUNTS = '423e50b26c4181e28edbf59e3e483654', TASKS = '421e50b26c4181b8bc41f2c487b685b5', STORES = '421e50b26c418153be7ff03507895539', ORDER_LOG = '423e50b26c4181fbb853fab2c87a34ed';
const made = db => calls.filter(c => c.method === 'POST' && c.url.endsWith('/pages') && c.body.parent.database_id === db).map(c => c.body);
sec.fetchT = async (url, opts) => {
  const body = typeof opts.body === 'string' ? JSON.parse(opts.body) : null; calls.push({ method: opts.method, url, body });
  const ok = j => ({ ok: true, json: async () => j });
  if (url.includes('/file_uploads')) return ok({ id: 'file-1' });
  if (url.endsWith('/query') && url.includes(ORDER_LOG)) return ok({ results: logged ? [{ id: 'log-1' }] : [] });
  if (url.endsWith('/query') && url.includes(ACCOUNTS)) return ok({ results: accounts[body.filter.rich_text.equals] ? [accounts[body.filter.rich_text.equals]] : [] });
  if (url.endsWith('/query') && body.filter.and) return ok({ results: Object.values(rows).filter(r => r.properties.Stage.select.name === 'Started signup') });
  if (url.endsWith('/query')) { const id = body.filter.rich_text.equals; return ok({ results: rows[id] ? [rows[id]] : [] }); }
  if (opts.method === 'PATCH') return ok({ id: url.split('/').pop() });
  if (opts.method === 'POST' && url.endsWith('/pages')) return ok({ id: 'new-' + calls.length });
  return ok({ title: [{ plain_text: 'Stores' }] });
};
const notion = require('../lib/notion');
const rec = () => ({ store: { chainName: 'Sessions Cannabis' }, source: 'signup.poof.ca', owner: { name: 'Dana Lee', email: 'dana@store.ca' },
  systems: { pos: 'Greenline', processor: 'Helcim', delivery: true, deliverySoftware: 'Canfleet' }, referral: { code: 'POOF180' },
  acceptance: { at: '2026-11-23T22:00:00Z', name: 'Dana Lee' },
  locations: [{ id: 'CRSA1111111', name: 'Sessions Cannabis', addr: '1 A St', city: 'Barrie', postal: 'L4N 1A1' }, { id: 'CRSA2222222', name: 'Sessions Cannabis', addr: '2 B St', city: 'Windsor', postal: 'N9A 1A1' }] });
const row = (id, stage, cus) => ({ id: 'page-' + id, properties: { Stage: { select: { name: stage } }, 'Stripe Customer': { rich_text: cus ? [{ plain_text: cus }] : [] }, Notes: { rich_text: [{ plain_text: 'old note' }] } } });

test('signup updates existing rows, adds a missing one, queues three tasks', async () => {
  calls.length = 0; accounts = {}; logged = false; rows = { CRSA1111111: row('1', 'Not contacted') };
  const out = await notion.syncSignup(rec(), 'cus_1', { pdf: Buffer.from('%PDF-1.4 test'), orderFormUrl: 'https://onboarding.poof.ca/api/orderform?c=cus_1&t=x' });
  assert.deepEqual(out.errors, []);
  assert.deepEqual({ stores: out.stores, created: out.created, tasks: out.tasks }, { stores: 2, created: 1, tasks: 3 });
  const patch = calls.find(c => c.method === 'PATCH').body.properties;
  assert.equal(patch.Stage.select.name, 'Signed up'); assert.equal(patch.Source.select.name, 'signup.poof.ca');
  assert.equal(patch.POS.select.name, 'Greenline'); assert.equal(patch.Processor.select.name, 'Other');
  assert.equal(patch['Owner Email'].email, 'dana@store.ca'); assert.equal(patch['Discount Code'].rich_text[0].text.content, 'POOF180');
  assert.match(patch.Notes.rich_text[0].text.content, /old note\nProcessor: Helcim · Delivery: yes \(Canfleet, connects through Breadstack\) · Signed 2026-11-23 by Dana Lee/);
  assert.equal(made(STORES)[0].properties.Licence.rich_text[0].text.content, 'CRSA2222222');
  // one account page: contact, both stores linked, the order form copy attached and shown on the page
  const acct = made(ACCOUNTS); assert.equal(acct.length, 1);
  assert.equal(acct[0].properties.Account.title[0].text.content, 'Sessions Cannabis'); assert.equal(acct[0].properties.Stores.relation.length, 2);
  assert.equal(acct[0].properties['Order Form'].files[0].file_upload.id, 'file-1'); assert.equal(acct[0].properties.Locations.number, 2);
  assert.equal(acct[0].properties['Order Form Link'].url, 'https://onboarding.poof.ca/api/orderform?c=cus_1&t=x'); assert.equal(acct[0].properties.Stage.select.name, 'Signed up');
  assert.ok(acct[0].children.some(b => b.type === 'pdf')); assert.equal(out.account.pdf, true);
  // each location gets its own order form log entry, linked to its store and the account, with a copy of the PDF
  const log = made(ORDER_LOG); assert.equal(log.length, 2); assert.equal(out.orderForms, 2);
  assert.match(log[0].properties.Entry.title[0].text.content, /Sessions Cannabis \(Barrie\): signed 2026-11-23/);
  assert.equal(log[0].properties.Store.relation[0].id, 'page-1'); assert.equal(log[0].properties.Account.relation.length, 1);
  assert.equal(log[1].properties['Order Form'].files[0].file_upload.id, 'file-1'); assert.equal(log[0].properties['Discount Code'].rich_text[0].text.content, 'POOF180');
  assert.equal(patch['Signed On'].date.start, '2026-11-23'); assert.equal(patch.Delivery.rich_text[0].text.content, 'Yes: Canfleet');
  const tasks = made(TASKS);
  assert.ok(tasks.every(t => t.properties.Account.relation.length === 1), 'tasks link to the account');
  assert.deepEqual(tasks.map(t => t.properties.Type.select.name), ['Send next-steps email', 'Request POS credentials', 'Request processor credentials']);
  assert.deepEqual(tasks.map(t => t.properties.Status.status.name), ['Needs approval', 'Needs approval', 'Needs approval']);
  assert.equal(tasks[0].properties.Store.relation.length, 2); assert.equal(tasks[0].properties.Assignee.select.name, 'Lily');
  assert.ok(tasks[1].children.some(b => b.paragraph && b.paragraph.rich_text[0] && /Company ID/.test(b.paragraph.rich_text[0].text.content)));
  const bodyOf = t => t.children.map(b => b.paragraph ? (b.paragraph.rich_text[0] || { text: { content: '' } }).text.content : '').join('\n');
  assert.match(bodyOf(tasks[2]), /You told us you use Helcim as your payment processor\. We're working on setting up this integration\. Please connect us with your representative to speed up the process\./);
  assert.match(bodyOf(tasks[0]), /our team contacts Greenline to set up the connection/);
  assert.match(bodyOf(tasks[0]), /For Helcim: We're working on setting up this integration/);
  assert.match(bodyOf(tasks[0]), /Canfleet delivery connects through Breadstack/);
});
test('a second sync of the same signup does not duplicate tasks', async () => {
  calls.length = 0; logged = true; accounts = { cus_1: { id: 'acct-1', properties: {} } }; rows = { CRSA1111111: row('1', 'Signed up', 'cus_1'), CRSA2222222: row('2', 'Signed up', 'cus_1') };
  const out = await notion.syncSignup(rec(), 'cus_1', { pdf: Buffer.from('x') });
  assert.equal(out.already, true); assert.equal(out.tasks, 0); assert.equal(out.account.created, false);
  assert.equal(calls.filter(c => c.method === 'POST' && c.url.endsWith('/pages')).length, 0);
  assert.equal(calls.filter(c => c.url.includes('/file_uploads')).length, 0, 'the PDF is uploaded once, when the account is made');
});
test('a store already further along keeps its stage', async () => {
  calls.length = 0; rows = { CRSA1111111: row('1', 'Live'), CRSA2222222: row('2', 'Not contacted') };
  await notion.syncSignup(rec(), 'cus_9');
  const patches = calls.filter(c => c.method === 'PATCH').map(c => c.body.properties);
  assert.equal(patches[0].Stage, undefined); assert.equal(patches[1].Stage.select.name, 'Signed up');
});
test('no token means nothing is called', async () => {
  calls.length = 0; delete process.env.NOTION_TOKEN;
  assert.deepEqual(await notion.syncSignup(rec(), 'cus_1'), { skipped: 'no NOTION_TOKEN' }); assert.equal(calls.length, 0);
  process.env.NOTION_TOKEN = 'ntn_test';
});

test('picking a store marks it started, but never moves a signed-up store backwards', async () => {
  calls.length = 0; rows = { CRSA1111111: row('1', 'Not contacted'), CRSA2222222: row('2', 'Signed up', 'cus_1') };
  assert.deepEqual(await notion.markStarted('CRSA1111111', { email: 'dana@store.ca', name: 'Dana Lee', source: 'signup.poof.ca' }), { ok: true });
  const p = calls.find(c => c.method === 'PATCH').body.properties;
  assert.equal(p.Stage.select.name, 'Started signup'); assert.equal(p['Owner Email'].email, 'dana@store.ca'); assert.ok(p['Next Action Due'].date.start);
  calls.length = 0;
  assert.match((await notion.markStarted('CRSA2222222', { email: 'x@y.ca' })).skipped, /Signed up/); assert.equal(calls.filter(c => c.method === 'PATCH').length, 0);
});
test('the daily sweep hands an unanswered drop-off to a person once', async () => {
  calls.length = 0;
  rows = { CRSA1111111: { id: 'page-1', properties: { Stage: { select: { name: 'Started signup' } }, Store: { title: [{ plain_text: 'Sessions Cannabis' }] }, City: { rich_text: [{ plain_text: 'Barrie' }] },
    Licence: { rich_text: [{ plain_text: 'CRSA1111111' }] }, 'Owner Email': { email: 'dana@store.ca' }, 'Owner Name': { rich_text: [{ plain_text: 'Dana Lee' }] } } } };
  const out = await notion.sweepDropoffs();
  assert.deepEqual({ due: out.due, tasks: out.tasks, errors: out.errors.length }, { due: 1, tasks: 1, errors: 0 });
  const t = made(TASKS)[0];
  assert.equal(t.properties.Type.select.name, 'Drop-off follow-up'); assert.equal(t.properties.Assignee.select.name, 'Lily'); assert.equal(t.properties.Store.relation[0].id, 'page-1');
  assert.ok(t.children.some(b => b.paragraph && b.paragraph.rich_text[0] && /signup\.poof\.ca\/\?store=CRSA1111111/.test(b.paragraph.rich_text[0].text.content)));
  assert.equal(calls.find(c => c.method === 'PATCH').body.properties.Stage.select.name, 'Stalled');
});

test('an account moved on the board carries its locations with it', async () => {
  calls.length = 0;
  const orig = sec.fetchT;
  sec.fetchT = async (url, opts) => {
    if (url.endsWith('/query') && url.includes(ACCOUNTS)) { calls.push({ method: 'POST', url, body: JSON.parse(opts.body) }); return { ok: true, json: async () => ({ results: [
      { id: 'a1', properties: { Stage: { select: { name: 'Building in Poof HQ' } }, Stores: { relation: [{ id: 's1' }, { id: 's2' }] } } },
      { id: 'a2', properties: { Stage: { select: { name: 'Signed up' } }, Stores: { relation: [{ id: 's3' }] } } }] }) }; }
    return orig(url, opts);
  };
  const out = await notion.syncStages();
  sec.fetchT = orig;
  assert.deepEqual({ accounts: out.accounts, stores: out.stores, errors: out.errors }, { accounts: 1, stores: 2, errors: [] });
  const patches = calls.filter(c => c.method === 'PATCH');
  assert.deepEqual(patches.map(c => c.url.split('/').pop()), ['s1', 's2']);
  assert.ok(patches.every(c => c.body.properties.Stage.select.name === 'Building in Poof HQ'));
});
