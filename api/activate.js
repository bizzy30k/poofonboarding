// POST /api/activate   (admin only — go-live day)
// Headers: x-admin-key: <ADMIN_KEY>
// Body: { customerId, referralCode?, locations?, force? }
//   locations — optional subset of AGCO ids to activate now (default: all on the record)
//   force     — activate even if some doors are live on another customer
//
// Creates ONE subscription with quantity = number of locations, charged to the
// card on file. Promo priority: referral code they entered (or passed here) →
// launch offer (if they added a card during the offer window) → none.
// Idempotent: a second call updates the quantity instead of creating another.
//
// curl -X POST https://onboarding.poof.ca/api/activate \
//   -H "x-admin-key: $ADMIN_KEY" -H "Content-Type: application/json" \
//   -d '{"customerId":"cus_123"}'
const Stripe = require('stripe');
const config = require('../lib/config');
const record = require('../lib/record');
const { findConflicts } = require('../lib/conflicts');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!config.ADMIN_KEY || req.headers['x-admin-key'] !== config.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const stripe = new Stripe(config.STRIPE_SECRET_KEY);
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { customerId, referralCode, locations, force } = body;
    const customer = await stripe.customers.retrieve(customerId);
    const rec = record.unpack(customer.metadata || {});
    if (!rec || !rec.acceptance?.at) return res.status(400).json({ error: 'No accepted agreement on this customer.' });
    const pm = customer.invoice_settings?.default_payment_method;
    if (!pm) return res.status(400).json({ error: 'No card on file. Collect it (Stripe → customer → add payment method → set as default) and run again.' });

    const ids = Array.isArray(locations) && locations.length ? locations : rec.locations.map(l => l.id);
    const qty = rec.locations.filter(l => ids.includes(l.id)).length;
    if (!qty) return res.status(400).json({ error: 'No matching locations.' });

    // Franchise guard: refuse doors already live elsewhere unless forced
    const conflicts = (await findConflicts(stripe, rec.store.chainName, ids, customerId)).filter(c => /live/i.test(c.stage));
    if (conflicts.length && !force) return res.status(409).json({ error: 'Some doors are already live on another account. Pass force:true to activate anyway.', conflicts });

    let promo = null, promoSource = null;
    const codes = [[(referralCode || rec.referral?.code || '').toUpperCase(), 'referral'], [rec.offer ? rec.offer.code : '', 'launch offer']];
    for (const [code, src] of codes) {
      if (!code) continue;
      const list = await stripe.promotionCodes.list({ code, active: true, limit: 1 });
      if (list.data[0]) { promo = list.data[0]; promoSource = src; break; }
    }

    const existing = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 5 });
    const live = existing.data.find(s => ['active', 'trialing', 'past_due'].includes(s.status));
    let sub;
    if (live) {
      sub = await stripe.subscriptions.update(live.id, {
        items: [{ id: live.items.data[0].id, price: config.PRICE_ID, quantity: qty }],
        proration_behavior: 'create_prorations',
        metadata: { poof_locations: ids.join(','), poof_activated_at: new Date().toISOString() },
      });
    } else {
      sub = await stripe.subscriptions.create({
        customer: customerId,
        items: [{ price: config.PRICE_ID, quantity: qty }],
        default_payment_method: pm,
        collection_method: 'charge_automatically',
        automatic_tax: { enabled: true },
        ...(promo ? { promotion_code: promo.id } : {}),
        metadata: { poof_store_name: rec.store.chainName, poof_locations: ids.join(','), poof_activated_at: new Date().toISOString(), promo: promo ? `${promo.code} (${promoSource})` : '' },
      });
    }

    rec.activation = { at: new Date().toISOString(), subscription: sub.id, quantity: qty, locationIds: ids, promo: promo ? promo.code : null, promoSource };
    await stripe.customers.update(customerId, { metadata: { ...record.pack(rec, record.chunksIn(customer.metadata)), onboarding_stage: 'Live', subscription: sub.id } });

    return res.status(200).json({ ok: true, subscription: sub.id, status: sub.status, quantity: qty, monthly: qty * config.PRICE_CAD, promo: promo ? promo.code : null, promoSource, conflictsOverridden: conflicts });
  } catch (e) {
    console.error('activate failed:', e);
    return res.status(500).json({ error: e.message });
  }
};
