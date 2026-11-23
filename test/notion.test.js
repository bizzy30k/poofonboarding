const test = require('node:test'); const assert = require('node:assert');
process.env.NOTION_TOKEN = 'ntn_test';
const sec = require('../lib/security');
const calls = [];
let rows = {};
sec.fetchT = async (url, opts) => {
  const body = opts.body ? JSON.parse(opts.body) : null; calls.push({ method: opts.method, url, body });
  const ok = j => ({ ok: true, json: async () => j });
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
  calls.length = 0; rows = { CRSA1111111: row('1', 'Not contacted') };
  const out = await notion.syncSignup(rec(), 'cus_1');
  assert.deepEqual({ stores: out.stores, created: out.created, tasks: out.tasks, errors: out.errors.length }, { stores: 2, created: 1, tasks: 3, errors: 0 });
  const patch = calls.find(c => c.method === 'PATCH').body.properties;
  assert.equal(patch.Stage.select.name, 'Signed up'); assert.equal(patch.Source.select.name, 'signup.poof.ca');
  assert.equal(patch.POS.select.name, 'Greenline'); assert.equal(patch.Processor.select.name, 'Other');
  assert.equal(patch['Owner Email'].email, 'dana@store.ca'); assert.equal(patch['Discount Code'].rich_text[0].text.content, 'POOF180');
  assert.match(patch.Notes.rich_text[0].text.content, /old note\nProcessor: Helcim · Delivery: yes \(Canfleet\) · Signed 2026-11-23 by Dana Lee/);
  const created = calls.filter(c => c.method === 'POST' && c.url.endsWith('/pages'));
  assert.equal(created[0].body.properties.Licence.rich_text[0].text.content, 'CRSA2222222');
  const tasks = created.slice(1).map(c => c.body);
  assert.deepEqual(tasks.map(t => t.properties.Type.select.name), ['Send next-steps email', 'Request POS credentials', 'Request processor credentials']);
  assert.deepEqual(tasks.map(t => t.properties.Status.status.name), ['Needs approval', 'Needs approval', 'To do']);
  assert.equal(tasks[0].properties.Store.relation.length, 2); assert.equal(tasks[0].properties.Assignee.select.name, 'Lily');
  assert.ok(tasks[1].children.some(b => b.paragraph && b.paragraph.rich_text[0] && /Company ID/.test(b.paragraph.rich_text[0].text.content)));
  assert.equal(tasks[2].children.length, 0, 'no draft where there is no template');
});
test('a second sync of the same signup does not duplicate tasks', async () => {
  calls.length = 0; rows = { CRSA1111111: row('1', 'Signed up', 'cus_1'), CRSA2222222: row('2', 'Signed up', 'cus_1') };
  const out = await notion.syncSignup(rec(), 'cus_1');
  assert.equal(out.already, true); assert.equal(out.tasks, 0);
  assert.equal(calls.filter(c => c.method === 'POST' && c.url.endsWith('/pages')).length, 0);
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
