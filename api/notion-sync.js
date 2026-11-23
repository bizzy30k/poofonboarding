// GET  /api/notion-sync                  → is the Notion connection working? (yes/no per database, nothing else)
// POST /api/notion-sync { customerId }   → admin only: write (or re-write) one signup into Notion.
// Signups are written automatically when they complete (see api/lead.js); this is the check and the backstop.
const sec = require('../lib/security');
const record = require('../lib/record');
const notion = require('../lib/notion');
const { stripeClient } = require('../lib/stripe');

const reason = v => v === true || (typeof v === 'string' && !/^Notion \d/.test(v)) ? 'ok'
  : /Notion 401/.test(v) ? 'token rejected' : /Notion 404/.test(v) ? 'not shared with the connection' : 'error';

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET') {
    if (!sec.rateLimit(`notion:check:${sec.clientIp(req)}`, 6, 60e3)) return sec.tooMany(res);
    const c = await notion.check().catch(e => ({ ok: false, reason: e.message }));
    if (c.reason) return res.status(200).json({ ok: false, token: 'missing' });
    return res.status(200).json({ ok: c.ok, token: 'set', stores: reason(c.stores), tasks: reason(c.tasks) });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!sec.requireAdmin(req, res)) return;
  try {
    const b = sec.body(req);
    const customerId = b && /^cus_[A-Za-z0-9]+$/.test(b.customerId || '') ? b.customerId : null;
    if (!customerId) return res.status(400).json({ error: 'customerId required.' });
    const customer = await stripeClient().customers.retrieve(customerId);
    const rec = record.unpack(customer.metadata || {});
    if (!rec || !rec.acceptance) return res.status(409).json({ error: 'That signup is not signed yet.' });
    return res.status(200).json(await notion.syncSignup(rec, customerId));
  } catch (e) {
    console.error('notion-sync failed', e.message);
    return res.status(500).json({ error: 'Sync failed.' });
  }
};
