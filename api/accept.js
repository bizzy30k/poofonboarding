// POST /api/accept
// Called after the terms step, and after the card step (or the card skip).
// Verifies the card if one was added, writes the acceptance record to the
// customer, flags franchise conflicts, builds the Order Form PDF, emails it,
// and returns the download link.
const Stripe = require('stripe');
const crypto = require('crypto');
const config = require('../lib/config');
const record = require('../lib/record');
const { buildOrderForm } = require('../lib/orderform');
const { sendSignupEmails } = require('../lib/mail');
const { findConflicts } = require('../lib/conflicts');
const core = require('../lib/core');

let termsHashCache = null;
async function termsHash() {
  if (termsHashCache) return termsHashCache;
  try {
    const r = await fetch(config.TERMS_URL, { headers: { 'User-Agent': 'poof-onboarding' } });
    termsHashCache = crypto.createHash('sha256').update((await r.text()).replace(/\s+/g, ' ')).digest('hex');
  } catch (e) { termsHashCache = 'unavailable'; }
  return termsHashCache;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!config.STRIPE_SECRET_KEY) return res.status(500).json({ error: 'Stripe is not configured.' });
  const stripe = new Stripe(config.STRIPE_SECRET_KEY);

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { customerId, setupIntentId, acceptance, cardSkipped } = body;
    if (!/^cus_/.test(customerId || '')) return res.status(400).json({ error: 'Missing customer.' });
    if (!acceptance?.name || !acceptance?.title || !acceptance?.agreed || !acceptance?.authorised) {
      return res.status(400).json({ error: 'Both boxes must be ticked and name and title filled in.' });
    }

    const customer = await stripe.customers.retrieve(customerId);
    const rec = record.unpack(customer.metadata || {});
    if (!rec) return res.status(400).json({ error: 'Signup record not found.' });

    // 1. Card — required unless explicitly skipped (single-door path)
    let si = null;
    if (!cardSkipped) {
      si = await stripe.setupIntents.retrieve(setupIntentId);
      if (si.customer !== customerId || si.status !== 'succeeded') return res.status(400).json({ error: 'Card was not saved. Please add it again.' });
    }

    // 2. Acceptance record
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
    rec.acceptance = {
      name: String(acceptance.name).slice(0, 120),
      title: String(acceptance.title).slice(0, 80),
      email: rec.owner.email,
      at: new Date().toISOString(),
      ip,
      userAgent: String(req.headers['user-agent'] || '').slice(0, 200),
      termsVersion: config.TERMS_VERSION,
      termsUrl: config.TERMS_URL,
      termsHash: await termsHash(),
      locationCount: rec.locations.length,
    };
    rec.customerId = customerId;
    rec.setupIntent = si ? si.id : null;
    rec.paymentMethod = si ? si.payment_method : null;
    rec.cardSkipped = !si;
    // Launch offer: card on file during the offer window → 3 months free at go-live
    rec.offer = (si && config.offerActive()) ? { code: config.LAUNCH_OFFER.code, months: config.LAUNCH_OFFER.months, grantedAt: rec.acceptance.at } : null;

    // 3. Franchise guard — flag doors already on another customer
    rec.conflicts = await findConflicts(stripe, rec.store.chainName, rec.locations.map(l => l.id), customerId);

    const update = { metadata: record.pack(rec, record.chunksIn(customer.metadata)) };
    if (si) update.invoice_settings = { default_payment_method: si.payment_method };
    update.metadata.conflicts = rec.conflicts.length ? rec.conflicts.map(c => `${c.customerId}:${c.overlap.length}`).join(';').slice(0, 500) : '';
    update.metadata.offer = rec.offer ? rec.offer.code : '';
    update.metadata.card_on_file = si ? 'yes' : 'no — collect on setup call';
    await stripe.customers.update(customerId, update);

    // 4. Order form + emails. Never block the retailer on these.
    const token = config.sign(customerId);
    const orderFormUrl = `${config.SITE_URL}/api/orderform?c=${customerId}&t=${token}`;
    let mail = {};
    try { const pdf = await buildOrderForm(rec); mail = await sendSignupEmails(rec, pdf, orderFormUrl); } catch (e) { mail = { error: e.message }; }

    // 5. Tell Poof HQ core (system of record). Never blocks the retailer.
    const coreSync = await core.notifyCore(rec, { event: 'signup.accepted', customerId, orderFormUrl, stage: 'accepted' });
    if (coreSync.error || coreSync.ok === false) console.warn('core sync (accept):', coreSync);

    return res.status(200).json({ ok: true, orderFormUrl, acceptedAt: rec.acceptance.at, offer: rec.offer, mail: { retailer: !!(mail.retailer && mail.retailer.id) } });
  } catch (err) {
    console.error('accept failed:', err);
    return res.status(500).json({ error: 'Could not record your acceptance. Please try again.' });
  }
};
