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
const { stripeClient } = require('../lib/stripe');
const promos = require('../lib/promo');
const config = require('../lib/config');
const record = require('../lib/record');
const { findConflicts } = require('../lib/conflicts');
const core = require('../lib/core');
const sec = require('../lib/security');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!sec.requireAdmin(req, res)) return;
  if (!sec.rateLimit(`admin:${sec.clientIp(req)}`, 30, 60e3)) return sec.tooMany(res);
  const stripe = stripeClient();
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
    const guard = await findConflicts(stripe, ids, customerId, rec.owner && rec.owner.email);
    if (!guard.ok && !force) return res.status(503).json({ error: 'Could not verify other accounts for these doors (Stripe search failed). Retry, or pass force:true.' });
    const conflicts = guard.conflicts.filter(c => /live/i.test(c.stage));
    if (conflicts.length && !force) return res.status(409).json({ error: 'Some doors are already live on another account. Pass force:true to activate anyway.', conflicts });

    // Discount priority: the code they entered (or the one passed here) while it is active → the coupon
    // locked onto the record at signup, if that code has since been switched off → the launch offer.
    let promo = null, promoSource = null, lockedCoupon = null;
    const refCode = promos.normCode(typeof referralCode === 'string' ? referralCode : (rec.referral?.code || ''));
    promo = await promos.findActive(stripe, refCode);
    if (promo) promoSource = 'referral';
    if (!promo && rec.referral && rec.referral.couponId && refCode === rec.referral.code) {
      const c = await stripe.coupons.retrieve(rec.referral.couponId).catch(() => null);
      if (c && c.valid) { lockedCoupon = c.id; promoSource = 'referral (locked at signup)'; }
    }
    if (!promo && !lockedCoupon && rec.offer) {
      promo = await promos.findActive(stripe, rec.offer.code);
      if (promo) promoSource = 'launch offer';
    }
    const promoCode = promo ? promo.code : lockedCoupon ? rec.referral.code : null;
    // A code with a fixed free period (coupon metadata free_days / free_until) is applied as a trial that ends
    // `free_days` after go-live and never later than `free_until`. It replaces the coupon, so nothing stacks.
    const terms = promoSource && promoSource.startsWith('referral')
      ? (promo ? promos.freeTerms(promo.coupon) : (rec.referral.days ? { days: rec.referral.days, until: rec.referral.until || null } : null))
      : null;
    const trialEnd = terms ? promos.trialEnd(terms) : null;
    const windowClosed = !!terms && !trialEnd; // the free window ended before this store went live: no discount at all

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
        ...(terms ? (trialEnd ? { trial_end: trialEnd } : {}) : promo ? { promotion_code: promo.id } : lockedCoupon ? { discounts: [{ coupon: lockedCoupon }] } : {}),
        metadata: { poof_store_name: rec.store.chainName, poof_locations: ids.join(','), poof_activated_at: new Date().toISOString(), promo: promoCode ? `${promoCode} (${promoSource})${trialEnd ? ` free until ${new Date(trialEnd * 1000).toISOString().slice(0, 10)}` : windowClosed ? ' free window closed' : ''}` : '' },
      });
    }

    rec.activation = { at: new Date().toISOString(), subscription: sub.id, quantity: qty, locationIds: ids, promo: windowClosed ? null : promoCode, promoSource, freeUntil: trialEnd ? new Date(trialEnd * 1000).toISOString() : null };
    await stripe.customers.update(customerId, { metadata: { ...record.pack(rec, record.chunksIn(customer.metadata)), onboarding_stage: 'Live', subscription: sub.id } });

    // Tell Poof HQ core the doors are live (core flips isActive on its side)
    const coreSync = await core.notifyCore({ ...rec, locations: rec.locations.filter(l => ids.includes(l.id)) }, { event: 'signup.activated', customerId, subscriptionId: sub.id, stage: 'live' });
    if (coreSync.error || coreSync.ok === false) console.warn('core sync (activate):', coreSync);

    return res.status(200).json({ ok: true, coreSync, subscription: sub.id, status: sub.status, quantity: qty, monthly: qty * config.PRICE_CAD, promo: windowClosed ? null : promoCode, promoSource, freeUntil: trialEnd ? new Date(trialEnd * 1000).toISOString() : null, conflictsOverridden: conflicts });
  } catch (e) {
    console.error('activate failed:', e);
    console.error('activate failed:', { err: e.message });
    return res.status(500).json({ error: 'Activation failed. Check the server log.' });
  }
};
