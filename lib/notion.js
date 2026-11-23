// Notion: the retailer operations base ("Poof Retail Data Room").
// When a signup is signed, each store's row in the Stores database is updated and the
// first tasks for the onboarding queue are created, with the email drafts in the task body.
// Nothing is ever sent from here: a person approves each draft in Notion.
//
// Needs NOTION_TOKEN (an internal integration that has been added to the data room page).
// Without it every call is a no-op, so the signup flow never depends on Notion.
const config = require('./config');
const sec = require('./security');

const TOKEN = () => process.env.NOTION_TOKEN || '';
const STORES_DB = process.env.NOTION_STORES_DB || '421e50b26c418153be7ff03507895539';
const TASKS_DB = process.env.NOTION_TASKS_DB || '421e50b26c4181b8bc41f2c487b685b5';
const MAX_LOCATIONS = 40;

const POS_OPTIONS = ['Cova', 'Greenline', 'Blaze', 'Dutchie POS', 'Tendy'];
const PROCESSOR_OPTIONS = ['Merrco', 'Moneris', 'Clover'];
// What Poof connects to today. Anything else gets the "we're working on it" reply.
const LIVE_POS = new Set(['cova', 'greenline']);
const LIVE_PROCESSORS = new Set(['merrco', 'moneris']);
const LIVE_DELIVERY = new Set(['canfleet']);            // through Breadstack
const NO_DELIVERY_SOFTWARE = /^(our own drivers|none|no software)/i;
const IN_PROGRESS = "We're working on setting up this integration. Please connect us with your representative to speed up the process.";
// A store already past "Signed up" keeps its stage.
const LATER_STAGES = new Set(['Credentials requested', 'Building in Poof HQ', 'Live']);

async function call(method, path, body) {
  const r = await sec.fetchT('https://api.notion.com/v1' + path, {
    method,
    headers: { Authorization: `Bearer ${TOKEN()}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }, 6000);
  if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error(`Notion ${r.status} ${path}: ${t.slice(0, 200)}`); }
  return r.json();
}

const text = s => ({ rich_text: s ? [{ text: { content: String(s).slice(0, 1900) } }] : [] });
const title = s => ({ title: [{ text: { content: String(s || '').slice(0, 200) } }] });
const select = name => ({ select: name ? { name } : null });
const pick = (value, options) => !value ? null : options.find(o => o.toLowerCase() === String(value).toLowerCase()) || 'Other';
const plain = prop => ((prop && (prop.rich_text || prop.title)) || []).map(t => t.plain_text || '').join('');
// Today in Ontario, as YYYY-MM-DD.
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

async function findStore(licence) {
  const r = await call('POST', `/databases/${STORES_DB}/query`, { filter: { property: 'Licence', rich_text: { equals: licence } }, page_size: 1 });
  return (r.results || [])[0] || null;
}

function storeProps(rec, customerId, existing) {
  const pos = rec.systems && rec.systems.pos, proc = rec.systems && rec.systems.processor;
  const posPick = pick(pos, POS_OPTIONS), procPick = pick(proc, PROCESSOR_OPTIONS);
  const notes = [];
  if (posPick === 'Other' && pos && pos !== 'Other') notes.push(`POS: ${pos}`);
  if (procPick === 'Other' && proc && proc !== 'Other') notes.push(`Processor: ${proc}`);
  if (rec.systems && rec.systems.delivery != null) notes.push(rec.systems.delivery ? `Delivery: yes${rec.systems.deliverySoftware ? ' (' + rec.systems.deliverySoftware + (LIVE_DELIVERY.has(String(rec.systems.deliverySoftware).toLowerCase()) ? ', connects through Breadstack' : '') + ')' : ''}` : 'Delivery: no');
  if (rec.acceptance && rec.acceptance.at) notes.push(`Signed ${String(rec.acceptance.at).slice(0, 10)}${rec.acceptance.name ? ' by ' + rec.acceptance.name : ''}`);
  const stageNow = existing && existing.properties && existing.properties.Stage && existing.properties.Stage.select && existing.properties.Stage.select.name;
  const oldNotes = existing ? plain(existing.properties.Notes) : '';
  const props = {
    Source: select(rec.source === 'signup.poof.ca' ? 'signup.poof.ca' : 'onboarding.poof.ca'),
    POS: select(posPick),
    Processor: select(procPick),
    'Owner Name': text(rec.owner && rec.owner.name),
    'Owner Email': { email: (rec.owner && rec.owner.email) || null },
    'Discount Code': text((rec.referral && rec.referral.code) || (rec.offer && rec.offer.code) || ''),
    'Billing Plan': select('Monthly'),
    'Stripe Customer': text(customerId),
    'Needs Verification': { checkbox: false },
    'Next Action Due': { date: { start: today() } },
    Notes: text([oldNotes, notes.join(' · ')].filter(Boolean).join('\n')),
  };
  if (!LATER_STAGES.has(stageNow)) props.Stage = select('Signed up');
  return props;
}

// ---- email drafts (wording lives in the data room's "Email templates" page) ----
const locList = rec => rec.locations.map(l => `- ${l.addr}, ${l.city} ${l.postal || ''}`.trim()).join('\n');
function drafts(rec) {
  const name = rec.store.chainName, email = rec.owner.email;
  const pos = (rec.systems && rec.systems.pos) || '', proc = (rec.systems && rec.systems.processor) || '';
  const out = [];
  const p = pos.toLowerCase(), c = proc.toLowerCase();
  const dsw = (rec.systems && rec.systems.delivery && rec.systems.deliverySoftware) || '';
  const live = [LIVE_POS.has(p) ? pos : null, LIVE_PROCESSORS.has(c) ? proc : null].filter(Boolean);
  const pending = [pos && !LIVE_POS.has(p) ? pos : null, proc && !LIVE_PROCESSORS.has(c) ? proc : null,
    dsw && !LIVE_DELIVERY.has(dsw.toLowerCase()) && !NO_DELIVERY_SOFTWARE.test(dsw) ? dsw : null].filter(Boolean);
  const nextLines = [];
  if (live.length) nextLines.push(`Next, our team contacts ${live.join(' and ')} to set up the connection. They may reach out to you directly to confirm once we start the request.`);
  if (pending.length) nextLines.push(`For ${pending.join(' and ')}: ${IN_PROGRESS}`);
  if (dsw && LIVE_DELIVERY.has(dsw.toLowerCase())) nextLines.push(`Your ${dsw} delivery connects through Breadstack, and we'll set that up as part of your onboarding.`);
  if (!nextLines.length) nextLines.push("Next, our team will reach out to confirm which point of sale and payment processor you use, so we can connect your store.");
  out.push({
    task: `Send next steps: ${name}`, type: 'Send next-steps email', status: 'Needs approval', estimate: 5, notes: `To: ${email}`,
    body: `To: ${email}\nSubject: Thank you and next steps: Poof Marketplace\n\nHello ${name},\n\nThank you for signing up with Poof. We're glad to have you on board.\n\nFrom your signup, you're using:\n- POS: ${pos || 'not provided'}\n- Payment processor: ${proc || 'not provided'}\n\n${nextLines.join('\n\n')}\n\nWe'll follow this email with anything else we need from you. If you have questions in the meantime, reply to this email.\n\nThank you for choosing Poof.`,
  });
  if (p === 'cova') out.push({ task: `Request Cova onboarding package: ${name}`, type: 'Request POS credentials', status: 'Needs approval', estimate: 10, notes: `To: Cova (copy ${email})`,
    body: `To: Cova (copy ${email})\nSubject: Onboarding request: ${name}\n\nHello,\n\nWe are onboarding ${name}, located at:\n${locList(rec)}\n\nWe are requesting their onboarding package. The store is copied on this email.\n\nPlease let me know if you need anything else from our side to start the process.\n\nThank you in advance.` });
  else if (p === 'greenline') out.push({ task: `Request Greenline IDs: ${name}`, type: 'Request POS credentials', status: 'Needs approval', estimate: 10, notes: `To: ${email}`,
    body: `To: ${email}\nSubject: Two details needed to connect ${name} to Poof\n\nHello,\n\nTo finish your setup, please send us these two details from Greenline for each location:\n- Company ID\n- Location ID\n\nYou'll find them here:\n1. Go to the Integration tab.\n2. Select Overview.\n3. Click API Keys at the top right.\n4. Find Poof Technologies in the list and switch the integration on.\n\nWe need them for these locations:\n${locList(rec)}\n\nOnce we have them, we'll complete the connection. Reply here if anything is unclear.` });
  else if (pos) out.push({ task: `Ask for a ${pos} contact (integration not live yet): ${name}`, type: 'Request POS credentials', status: 'Needs approval', estimate: 5, notes: `To: ${email}. ${pos} is not connected yet.`,
    body: `To: ${email}\nSubject: Your ${pos} connection with Poof\n\nHello,\n\nThank you for signing up ${name} with Poof.\n\nYou told us you use ${pos} as your point of sale. ${IN_PROGRESS}\n\nIf you can introduce us to your ${pos} representative by replying to this email with them copied, we'll take it from there.\n\nThank you.` });
  else out.push({ task: `Find out which POS they use: ${name}`, type: 'Request POS credentials', status: 'To do', estimate: 5, notes: `The signup did not say which POS. Ask ${email}.`, body: '' });

  if (c === 'moneris') out.push({ task: `Request Moneris Store ID and API Token: ${name}`, type: 'Request processor credentials', status: 'Needs approval', estimate: 10, notes: `To: ${email}`,
    body: `To: ${email}\nSubject: Connecting your Moneris account to Poof\n\nHello,\n\nTo take payments for Poof orders through your own Moneris account, we need two details from your Moneris Merchant Resource Center:\n- Store ID\n- API Token\n\nPlease send them for each location below. If you're not sure where to find them, reply and we'll walk you through it.\n\n${locList(rec)}\n\nThank you.` });
  else if (c === 'merrco') out.push({ task: `Request Merrco client ID and secret: ${name}`, type: 'Request processor credentials', status: 'Needs approval', estimate: 10, notes: `To: Merrco (copy ${email})`,
    body: `To: Merrco (copy ${email})\nSubject: Poof integration request: ${name}\n\nHello,\n\nWe are onboarding ${name} to the Poof marketplace, located at:\n${locList(rec)}\n\nThe store is copied on this email and has authorized the connection.\n\nCould you please provide the client ID and secret for this merchant so we can complete the integration?\n\nPlease let me know if you need anything else from us or from the store.\n\nThank you.` });
  else if (proc) out.push({ task: `Ask for a ${proc} contact (integration not live yet): ${name}`, type: 'Request processor credentials', status: 'Needs approval', estimate: 5, notes: `To: ${email}. ${proc} is not connected yet.`,
    body: `To: ${email}\nSubject: Your ${proc} connection with Poof\n\nHello,\n\nThank you for signing up ${name} with Poof.\n\nYou told us you use ${proc} as your payment processor. ${IN_PROGRESS}\n\nIf you can introduce us to your ${proc} representative by replying to this email with them copied, we'll take it from there.\n\nThank you.` });
  else out.push({ task: `Find out which processor they use: ${name}`, type: 'Request processor credentials', status: 'To do', estimate: 5, notes: `The signup did not say which processor. Ask ${email}.`, body: '' });
  return out;
}
const blocks = body => !body ? [] : [
  { object: 'block', type: 'callout', callout: { rich_text: [{ text: { content: 'Draft. Read it, fix anything that is off, send it from contact@poof.ca, then mark this task Done.' } }] } },
  ...body.split('\n').slice(0, 90).map(line => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: line ? [{ text: { content: line.slice(0, 1900) } }] : [] } })),
];

// Update (or add) each store row, then create the first tasks once per signup.
async function syncSignup(rec, customerId) {
  if (!TOKEN()) return { skipped: 'no NOTION_TOKEN' };
  const out = { stores: 0, created: 0, tasks: 0, already: false, errors: [] };
  const pageIds = [];
  let alreadySynced = true;
  for (const l of rec.locations.slice(0, MAX_LOCATIONS)) {
    try {
      const existing = await findStore(l.id);
      if (!existing || plain(existing.properties['Stripe Customer']) !== customerId) alreadySynced = false;
      const props = storeProps(rec, customerId, existing);
      if (existing) { await call('PATCH', `/pages/${existing.id}`, { properties: props }); pageIds.push(existing.id); }
      else {
        const made = await call('POST', '/pages', { parent: { database_id: STORES_DB }, properties: {
          ...props, Store: title(l.name || rec.store.chainName), Licence: text(l.id), Banner: text(rec.store.chainName),
          Address: text(l.addr), City: text(l.city), 'Postal Code': text(l.postal), 'AGCO Status': select('Authorized to Open'),
        } });
        pageIds.push(made.id); out.created++;
      }
      out.stores++;
    } catch (e) { alreadySynced = false; out.errors.push(`${l.id}: ${e.message}`); }
  }
  // Tasks only the first time this signup is synced, and only if at least one store row is linked.
  if (alreadySynced) { out.already = true; return out; }
  if (!pageIds.length) return out;
  for (const d of drafts(rec)) {
    try {
      await call('POST', '/pages', {
        parent: { database_id: TASKS_DB },
        properties: {
          Task: title(d.task), Type: select(d.type), Status: { status: { name: d.status } }, Assignee: select('Lily'),
          Due: { date: { start: today() } }, 'Estimate (min)': { number: d.estimate }, Notes: text(d.notes),
          Store: { relation: pageIds.slice(0, 100).map(id => ({ id })) },
        },
        children: blocks(d.body),
      });
      out.tasks++;
    } catch (e) { out.errors.push(`task "${d.task}": ${e.message}`); }
  }
  return out;
}

// Can the token see both databases? Used by the admin check.
async function check() {
  if (!TOKEN()) return { ok: false, reason: 'NOTION_TOKEN is not set' };
  const out = { ok: true };
  for (const [name, id] of [['stores', STORES_DB], ['tasks', TASKS_DB]]) {
    try { const d = await call('GET', `/databases/${id}`); out[name] = (d.title || []).map(t => t.plain_text).join('') || true; }
    catch (e) { out.ok = false; out[name] = e.message; }
  }
  return out;
}

module.exports = { syncSignup, check, drafts, storeProps };
