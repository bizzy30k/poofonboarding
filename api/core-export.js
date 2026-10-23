// GET /api/core-export   (admin only — Poof HQ core pulls signups in its own shape)
// Headers: x-admin-key: <ADMIN_KEY>     (header only — never in the URL)
// Query:
//   licenseNumber=CRSA…   one store document for that licence (404 if no signup has it)
//   customerId=cus_…      one signup envelope
//   since=ISO-8601        signups accepted/created after this time (default: all)
//   stage=in_progress|accepted|live   filter (default: accepted + live)
//   limit=N               max signups (default 100, max 500)
//
// Response: { count, signups: [ <envelope> ] }  — envelope = lib/core.toCoreSignup,
// i.e. { account, stores: [ <core store document> ] }, one store per CRSA.
// Poll this nightly, or wire CORE_WEBHOOK_URL for push; same payload either way.
const { stripeClient } = require('../lib/stripe');
const config = require('../lib/config');
const record = require('../lib/record');
const core = require('../lib/core');
const sec = require('../lib/security');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!sec.requireAdmin(req, res)) return;
  if (!sec.rateLimit(`admin:${sec.clientIp(req)}`, 30, 60e3)) return sec.tooMany(res);
  if (!config.STRIPE_SECRET_KEY) return res.status(500).json({ error: 'Stripe is not configured.' });
  const stripe = stripeClient();
  const q = req.query || {};

  try {
    const stageOf = (rec, customer) => (customer.metadata?.onboarding_stage === 'Live' ? 'live' : rec.acceptance?.at ? 'accepted' : 'in_progress');
    const envelope = (rec, customer) => core.toCoreSignup(rec, {
      event: 'signup.export', customerId: customer.id, stage: stageOf(rec, customer),
      subscriptionId: customer.metadata?.subscription || null,
      orderFormUrl: rec.acceptance?.at ? `${config.SITE_URL}/api/orderform?c=${customer.id}&t=${config.orderFormToken(customer.id)}` : null,
    });

    // Single customer
    if (q.customerId) {
      if (!/^cus_[A-Za-z0-9]+$/.test(String(q.customerId))) return res.status(400).json({ error: 'Bad customerId.' });
      const c = await stripe.customers.retrieve(String(q.customerId));
      const rec = record.unpack(c.metadata || {});
      if (!rec) return res.status(404).json({ error: 'No onboarding record on that customer.' });
      return res.status(200).json({ count: 1, signups: [await envelope(rec, c)] });
    }

    // Scan onboarding customers (metadata.source is set by lib/record.pack)
    const wantStages = q.stage ? String(q.stage).split(',') : ['accepted', 'live'];
    const since = q.since ? Date.parse(q.since) : 0;
    const limit = Math.min(parseInt(q.limit || '100', 10) || 100, 500);
    const out = [];
    for await (const c of stripe.customers.search({ query: "metadata['source']:'onboarding.poof.ca'", limit: 100 })) {
      const rec = record.unpack(c.metadata || {});
      if (!rec) continue;
      const stage = stageOf(rec, c);
      if (!wantStages.includes(stage)) continue;
      const t = Date.parse(rec.acceptance?.at || '') || c.created * 1000;
      if (since && t < since) continue;
      if (q.licenseNumber) {
        const lic = String(q.licenseNumber).toUpperCase();
        const loc = rec.locations.find(l => l.id === lic);
        if (!loc) continue;
        const env = await envelope(rec, c);
        return res.status(200).json({ count: 1, signups: [{ ...env, stores: env.stores.filter(d => d.licenseNumber === lic) }] });
      }
      out.push(await envelope(rec, c));
      if (out.length >= limit) break;
    }
    if (q.licenseNumber) return res.status(404).json({ error: 'No signup includes that licence.' });
    return res.status(200).json({ count: out.length, signups: out });
  } catch (err) {
    console.error('core-export failed:', err.message);
    return res.status(500).json({ error: 'Export failed.' });
  }
};
