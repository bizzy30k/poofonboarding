import Stripe from 'stripe';
import { createHash } from 'node:crypto';
import { putSubmission, newId } from '../lib/store.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

/** Path the flow is served from, relative to PUBLIC_BASE_URL. */
const BASE_PATH = (process.env.ONBOARDING_BASE_PATH || '/join').replace(/\/$/, '');

/**
 * Stripe Checkout in **setup** mode, not subscription mode.
 *
 * The flow promises "you won't be charged until the store is live", and setup
 * mode is the only way to keep that promise honestly: it vaults a payment method
 * against a Customer and creates nothing billable. The subscription is created
 * later by api/activate.js, when ops actually flips the store live.
 *
 * Subscription mode with a trial would look similar to the retailer but sets a
 * fixed trial end at signup — so a store that takes six weeks to integrate gets
 * billed before it has ever received an order. That is precisely the surprise
 * this flow is promising not to spring.
 */

/**
 * Live config, verified against the Stripe account:
 *   product  prod_V4WwQNpKS1WYXo  "Retail Ad Network", tax_code txcd_10103001
 *   price    lookup_key retail_ad_network_monthly, CAD $50.00, per_unit,
 *            monthly, tax_behavior EXCLUSIVE
 *   coupon   100% off, repeating 3 months, scoped to the product above
 *
 * Quantity is the number of Authorized Locations, per §6.3 of the Agreement.
 */

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const {
    profile, goals = [], contact = {}, stack = {},
    confirmedLocations = [], referralCode = null, acceptance = null
  } = req.body || {};

  if (!contact.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contact.email)) {
    return res.status(400).json({ error: 'A valid work email is required.' });
  }
  if (!profile?.storeName?.value) {
    return res.status(400).json({ error: 'Store name is missing.' });
  }

  // Defence in depth: credentials are collected in the admin panel, never here.
  // If anything that looks like a secret reaches this endpoint, drop the request
  // rather than persist it.
  if (containsSecret(stack)) {
    return res.status(400).json({
      error: 'Please don\'t enter API keys or passwords here — we collect those securely in your admin panel after setup.'
    });
  }

  if (!acceptance?.acceptedBy || !acceptance?.authorityAffirmed) {
    return res.status(400).json({ error: 'The terms need accepting before we can take a card.' });
  }

  const submissionId = newId();

  // Evidence of assent. The browser can't be trusted for these, so they're
  // recorded server-side alongside what the retailer confirmed on screen.
  const acceptanceRecord = {
    ...acceptance,
    ip: (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || null,
    userAgent: String(req.headers['user-agent'] || '').slice(0, 300),
    termsHash: createHash('sha256')
      .update(`${acceptance.termsUrl}|${acceptance.termsVersion}`)
      .digest('hex'),
    recordedAt: new Date().toISOString()
  };

  try {
    const referral = referralCode ? await resolveReferral(referralCode) : null;
    if (referralCode && !referral) {
      return res.status(400).json({ error: 'That referral code is not active. Leave it blank to continue.' });
    }

    const locationCount = Math.max(confirmedLocations.length || profile.locations?.length || 1, 1);

    const submission = {
      id: submissionId,
      profile,
      confirmedLocations,
      goals,
      locationCount,
      contact,
      stack,
      acceptance: acceptanceRecord,
      referral: referral
        ? { code: referral.code, brand: referral.brand, monthsCredited: referral.monthsCredited, promotionCodeId: referral.promotionCodeId }
        : null,
      createdAt: new Date().toISOString(),
      status: 'awaiting_payment_method'
    };

    const customer = await stripe.customers.create({
      email: contact.email,
      name: contact.name || undefined,
      phone: contact.phone || undefined,
      description: profile.storeName.value,
      // Stripe Tax needs an address to determine the jurisdiction. Every AGCO
      // record has one, so use the anchor location rather than asking again.
      address: taxAddress(confirmedLocations, profile),
      metadata: {
        submission_id: submissionId,
        store_name: String(profile.storeName.value).slice(0, 200),
        licence_number: String(profile.licenceNumber?.value || '').slice(0, 100),
        pos: String(stack.pos || ''),
        payment_processor: String(stack.payment || ''),
        goals: goals.join(','),
        accepted_by: String(acceptanceRecord.acceptedBy).slice(0, 100),
        accepted_at: acceptanceRecord.acceptedAt || '',
        terms_version: acceptanceRecord.termsVersion || '',
        referral_brand: referral?.brand || ''
      }
    });

    submission.stripeCustomerId = customer.id;
    await putSubmission(submissionId, submission);

    // The flow lives at a path on the main site, e.g.
    // https://business.poof.ca/join/ — not a subdomain.
    const origin = (process.env.PUBLIC_BASE_URL || `https://${req.headers.host}`).replace(/\/$/, '');

    // Embedded, so the card form mounts inside the chat instead of
    // redirecting away from it. return_url replaces success_url/cancel_url.
    const session = await stripe.checkout.sessions.create({
      mode: 'setup',
      ui_mode: 'embedded',
      customer: customer.id,
      currency: 'cad',
      client_reference_id: submissionId,
      metadata: {
        submission_id: submissionId,
        store_name: String(profile.storeName.value).slice(0, 200)
      },
      return_url: `${origin}${BASE_PATH}/?onboarding=complete&sid=${submissionId}&cs={CHECKOUT_SESSION_ID}`
    });

    return res.status(200).json({
      mode: 'embedded',
      clientSecret: session.client_secret,
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || null,
      submissionId,
      referral: submission.referral,
      // Shown above the card form so the retailer sees what they're agreeing to.
      quote: {
        locations: locationCount,
        unitAmount: 5000,
        currency: 'cad',
        subtotal: locationCount * 5000,
        rebateMonths: submission.referral ? (submission.referral.monthsCredited || 3) : 0
      }
    });
  } catch (err) {
    console.error('[checkout]', err);
    return res.status(500).json({ error: 'Could not open the secure payment form. Try again in a moment.' });
  }
}

/**
 * Brand referral → three months of credit.
 *
 * Validated at signup so the retailer sees it confirmed and it prints on the
 * agreement, but the coupon is only *applied* at activation — otherwise the
 * credit burns down during integration, before the store has earned a dollar.
 *
 *   stripe coupons create --percent-off=100 --duration=repeating --duration-in-months=3
 *   stripe promotion_codes create --coupon=<id> --code=BUZZD --metadata[brand]="Buzz'd"
 */
async function resolveReferral(code) {
  const clean = String(code).trim().toUpperCase();
  if (!clean) return null;

  const { data } = await stripe.promotionCodes.list({ code: clean, active: true, limit: 1 });
  const promo = data[0];
  if (!promo) return null;

  return {
    code: promo.code,
    promotionCodeId: promo.id,
    couponId: promo.coupon.id,
    brand: promo.metadata?.brand || promo.coupon.name || 'Referring brand',
    monthsCredited: promo.coupon.duration === 'repeating' ? promo.coupon.duration_in_months : null
  };
}

/** Anchor location address, for Stripe Tax jurisdiction. Ontario, always. */
function taxAddress(confirmed, profile) {
  const loc = (confirmed?.length ? confirmed : profile?.locations || [])[0];
  if (!loc) return undefined;
  const parts = String(loc.address || '').split(',').map(s => s.trim());
  return {
    line1: parts[0] || undefined,
    city: parts[1] || loc.name || undefined,
    postal_code: parts[2] || undefined,
    state: 'ON',
    country: 'CA'
  };
}

/** Cheap tripwire for credentials pasted into a free-text vendor field. */
function containsSecret(stack) {
  const blob = Object.values(stack || {}).filter(v => typeof v === 'string').join(' ');
  return /(sk_live|sk_test|pk_live|rk_live|api[_-]?key\s*[:=]|bearer\s+[\w-]{20,}|password\s*[:=])/i.test(blob)
    || /\b[A-Za-z0-9_-]{40,}\b/.test(blob);
}


