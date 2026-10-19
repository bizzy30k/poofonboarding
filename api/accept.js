// POST /api/accept
// Called once, after the agreement step and the card step (or the card skip).
// Verifies the card if one was added, writes the acceptance record to the
// customer, flags franchise conflicts, builds the Order Form PDF, emails it,
// notifies core, and returns the download link.
//
// Security model:
//  - requires the session token issued by /api/setup-intent (a cus_ id alone is not enough)
//  - write-once: a customer with an acceptance on file cannot be re-accepted; a retry
//    (same setupIntent, same session) returns the existing result instead of re-running
//  - every outbound call has a hard timeout; a slow email/webhook can't hang the retailer
const { stripeClient } = require('../lib/stripe');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../lib/config');
const record = require('../lib/record');
const { buildOrderForm } = require('../lib/orderform');
const { sendSignupEmails } = require('../lib/mail');
const { findConflicts } = require('../lib/conflicts');
const core = require('../lib/core');
const sec = require('../lib/security');

// Hash of the terms as committed in this repo (handover/terms.html), not the live page —
// so the recorded hash is reproducible from git and can't drift with nav/footer edits.
let termsHashCache = null;
function termsHash() {
  if (termsHashCache) return termsHashCache;
  try {
    const html = fs.readFileSync(path.join(__dirname, '..', 'handover', 'terms.html'), 'utf8');
    termsHashCache = crypto.createHash('sha256').update(html.replace(/\s+/g, ' ')).digest('hex');
  } catch (e) { termsHashCache = 'unavailable'; }
  return termsHashCache;
}

function orderFormUrl(customerId) { return `${config.SITE_URL}/api/orderform?c=${customerId}&t=${config.orderFormToken(customerId)}`; }

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!config.STRIPE_SECRET_KEY) return res.status(503).json({ error: 'Stripe is not configured.' });
  if (!sec.sameOrigin(req)) return res.status(403).json({ error: 'Forbidden' });
  const ip = sec.clientIp(req);
  if (!sec.rateLimit(`acc:${ip}`, 10, 60e3)) return sec.tooMany(res);
  const b = sec.body(req);
  if (!b) return res.status(400).json({ error: 'Bad request.' });
  const { customerId, setupIntentId, acceptance, cardSkipped, session } = b;
  if (!sec.checkSession(customerId, session)) return res.status(403).json({ error: 'Session expired. Please reload the page.' });
  const accName = sec.v.str(acceptance && acceptance.name, 120), accTitle = sec.v.str(acceptance && acceptance.title, 80);
  if (!accName || !accTitle || acceptance.agreed !== true || acceptance.authorised !== true) {
    return res.status(400).json({ error: 'Both boxes must be ticked and name and title filled in.' });
  }
  if (!cardSkipped && !/^seti_[A-Za-z0-9]+$/.test(setupIntentId || '')) return res.status(400).json({ error: 'Card was not saved. Please add it again.' });
  const stripe = stripeClient();

  try {
    const customer = await stripe.customers.retrieve(customerId);
    if (customer.deleted) return res.status(404).json({ error: 'Signup not found.' });
    const rec = record.unpack(customer.metadata || {});
    if (!rec) return res.status(400).json({ error: 'Signup record not found.' });

    // Write-once. A retry of the same acceptance returns the existing result; anything else is refused.
    if (rec.acceptance && rec.acceptance.at) {
      const sameCall = (cardSkipped ? rec.cardSkipped : rec.setupIntent === setupIntentId);
      if (!sameCall) return res.status(409).json({ error: 'This signup has already been completed.' });
      return res.status(200).json({ ok: true, orderFormUrl: orderFormUrl(customerId), acceptedAt: rec.acceptance.at, offer: rec.offer || null, mail: { retailer: true }, replay: true });
    }

    // 1. Card — required unless explicitly skipped
    let si = null;
    if (!cardSkipped) {
      si = await stripe.setupIntents.retrieve(setupIntentId);
      if (si.customer !== customerId || si.status !== 'succeeded') return res.status(400).json({ error: 'Card was not saved. Please add it again.' });
    }

    // 2. Acceptance record
    rec.acceptance = {
      name: accName, title: accTitle, email: rec.owner.email,
      at: new Date().toISOString(), ip,
      userAgent: String(req.headers['user-agent'] || '').slice(0, 200),
      termsVersion: config.TERMS_VERSION, termsUrl: config.TERMS_URL, termsHash: termsHash(),
      locationCount: rec.locations.length,
    };
    rec.customerId = customerId;
    rec.setupIntent = si ? si.id : null;
    rec.paymentMethod = si ? si.payment_method : null;
    rec.cardSkipped = !si;
    rec.offer = (si && config.offerActive()) ? { code: config.LAUNCH_OFFER.code, months: config.LAUNCH_OFFER.months, grantedAt: rec.acceptance.at } : null;

    // 3. Franchise guard — flag doors already on another customer (fail-open here; fail-closed at activation)
    const guard = await findConflicts(stripe, rec.locations.map(l => l.id), customerId, rec.owner.email);
    rec.conflicts = guard.conflicts;
    rec.conflictsChecked = guard.ok;

    const update = { metadata: record.pack(rec, record.chunksIn(customer.metadata)) };
    if (si) update.invoice_settings = { default_payment_method: si.payment_method };
    update.metadata.conflicts = rec.conflicts.length ? rec.conflicts.map(c => `${c.customerId}:${c.overlap.length}`).join(';').slice(0, 500) : '';
    update.metadata.offer = rec.offer ? rec.offer.code : '';
    update.metadata.card_on_file = si ? 'yes' : 'no — collect on setup call';
    await stripe.customers.update(customerId, update);

    // 4. Order form + emails + core. Each bounded; none can block the retailer for long.
    const url = orderFormUrl(customerId);
    let mail = {};
    try { const pdf = await buildOrderForm(rec); mail = await sendSignupEmails(rec, pdf, url); } catch (e) { mail = { error: e.message }; console.error('accept: mail failed', { customerId, err: e.message }); }
    const coreSync = await core.notifyCore(rec, { event: 'signup.accepted', customerId, orderFormUrl: url, stage: 'accepted' });
    if (coreSync.error || coreSync.ok === false) console.warn('accept: core sync failed', { customerId, coreSync });

    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(200).json({ ok: true, orderFormUrl: url, acceptedAt: rec.acceptance.at, offer: rec.offer, mail: { retailer: !!(mail.retailer && mail.retailer.id) } });
  } catch (err) {
    console.error('accept failed:', { customerId, ip, err: err.message });
    return res.status(500).json({ error: 'Could not record your acceptance. Please try again.' });
  }
};
