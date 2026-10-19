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
const core = require('../lib/core');
const sec = require('../lib/security');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!sec.requireAdmin(req, res)) return;
  if (!sec.rateLimit(`admin:${sec.clientIp(req)}`, 30, 60e3)) return sec.tooMany(res);
  const stripe = new Stripe(config.STRIPE_SECRET_KEY);
  try {
    const body = sec.body(req) || {};
    const { customerId, referralCode, locations, force } = body;
    if (!/^cus_[A-Za-z0-9]+$/.test(customerId || '')) return res.status(400).json({ error: 'customerId required.' });
    const customer = await stripe.customers.retrieve(customerId);
    const rec = record.unpack(customer.metadata || {});
    if (!rec || !rec.acceptance?.at) return res.status(400).json({ error: 'No accepted agreement on this customer.' });
    const pm = customer.invoice_settings?.default_payment_method;
    if (!pm) return res.status(400).json({ error: 'No card on file. Collect it (Stripe → customer → add payment method → set as default) and run again.' });

    const ids = Array.isArray(locations) && locations.length ? locations : rec.locations.map(l => l.id);
    const qty = rec.locations.filter(l => ids.includes(l.id)).length;
    if (!qty) return res.status(400).json({ error: 'No matching locations.' });

    // Franchise guard: refuse doors already live elsewhere unless forced. Fails CLOSED if the check itself fails.
    const guard = await findConflicts(stripe, ids, customerId);
    if (!guard.ok && !force) return res.status(503).json({ error: 'Could not verify other accounts for these doors (Stripe search failed). Retry, or pass force:true.' });
    const conflicts = guard.conflicts.filter(c => /live/i.test(c.stage));
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

    // Tell Poof HQ core the doors are live (core flips isActive on its side)
    const coreSync = await core.notifyCore({ ...rec, locations: rec.locations.filter(l => ids.includes(l.id)) }, { event: 'signup.activated', customerId, subscriptionId: sub.id, stage: 'live' });
    if (coreSync.error || coreSync.ok === false) console.warn('core sync (activate):', coreSync);

    return res.status(200).json({ ok: true, coreSync, subscription: sub.id, status: sub.status, quantity: qty, monthly: qty * config.PRICE_CAD, promo: promo ? promo.code : null, promoSource, conflictsOverridden: conflicts });
  } catch (e) {
    console.error('activate failed:', e);
    console.error('activate failed:', { err: e.message });
    return res.status(500).json({ error: 'Activation failed. Check the server log.' });
  }
};
