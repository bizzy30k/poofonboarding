import Stripe from 'stripe';
import { getSubmission, markSubmission } from '../lib/store.js';
import { sendGoLiveEmail } from '../lib/email.js';
import { appendToTracker } from '../lib/tracker.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

/**
 * POST /api/activate  { submissionId }
 * Header: x-poof-admin-key
 *
 * Called when ops confirms the store is live on the network. This is the moment
 * billing starts — the card vaulted at signup is charged from here forward, and
 * a referral credit (if any) begins now rather than at signup.
 *
 * Deliberately not exposed to the retailer. Guard it with ADMIN_API_KEY until the
 * admin panel exists, then move it behind the panel's own auth.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const expected = process.env.ADMIN_API_KEY;
  if (!expected) {
    return res.status(503).json({ error: 'Activation is not configured. Set ADMIN_API_KEY.' });
  }
  if (!timingSafeEqual(req.headers['x-poof-admin-key'] || '', expected)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { submissionId, goLiveDate = null } = req.body || {};
  if (!submissionId) return res.status(400).json({ error: 'submissionId is required.' });

  try {
    const submission = await getSubmission(submissionId);
    if (!submission) return res.status(404).json({ error: 'Submission not found.' });
    if (submission.status === 'live') {
      return res.status(200).json({ alreadyLive: true, subscriptionId: submission.stripeSubscriptionId });
    }
    if (!submission.stripeCustomerId || !submission.paymentMethodId) {
      return res.status(409).json({ error: 'No payment method on file for this submission.' });
    }

    // One line item, quantity = Authorized Locations (§6.3).
    const price = process.env.STRIPE_PRICE_AD_NETWORK;
    const quantity = Math.max(
      submission.locationCount
        || submission.confirmedLocations?.length
        || submission.profile?.locations?.length
        || 1,
      1
    );
    const items = price ? [{ price, quantity }] : [];

    let subscription = null;

    if (items.length) {
      subscription = await stripe.subscriptions.create({
        customer: submission.stripeCustomerId,
        items,
        default_payment_method: submission.paymentMethodId,
        // Stripe Tax adds HST on top: the price is tax_behavior=exclusive.
        automatic_tax: { enabled: true },
        // The credit clock starts now, on go-live — not at signup.
        discounts: submission.referral?.couponId || submission.referral?.promotionCodeId
          ? [submission.referral.couponId
              ? { coupon: submission.referral.couponId }
              : { promotion_code: submission.referral.promotionCodeId }]
          : undefined,
        description: `Poof Retail Network — ${submission.profile?.storeName?.value || ''}`,
        metadata: {
          submission_id: submissionId,
          store_name: String(submission.profile?.storeName?.value || '').slice(0, 200),
          goals: (submission.goals || []).join(','),
          referral_brand: submission.referral?.brand || '',
          locations: String(quantity),
          went_live: goLiveDate || new Date().toISOString().slice(0, 10)
        }
      });
    }

    const patch = {
      status: 'live',
      liveAt: new Date().toISOString(),
      goLiveDate: goLiveDate || new Date().toISOString().slice(0, 10),
      stripeSubscriptionId: subscription?.id || null
    };
    await markSubmission(submissionId, patch);

    await sendGoLiveEmail({ ...submission, ...patch }).catch(err =>
      console.error('[activate] go-live email failed:', err.message));

    await appendToTracker({ ...submission, ...patch }).catch(err =>
      console.error('[activate] tracker update failed:', err.message));

    return res.status(200).json({
      ok: true,
      subscriptionId: subscription?.id || null,
      quantity,
      billing: items.length ? 'started' : 'STRIPE_PRICE_AD_NETWORK not set — nothing billed'
    });
  } catch (err) {
    console.error('[activate]', err);
    return res.status(500).json({ error: 'Activation failed.' });
  }
}

/** Constant-time compare so the key can't be probed a character at a time. */
function timingSafeEqual(a, b) {
  const x = String(a), y = String(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  }
  return diff === 0;
}
