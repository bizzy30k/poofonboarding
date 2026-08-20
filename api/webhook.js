import Stripe from 'stripe';
import { getSubmission, markSubmission } from '../lib/store.js';
import { sendWelcomeEmail, sendOrderFormToOps } from '../lib/email.js';
import { buildOrderForm, ORDER_FORM_VERSION } from '../lib/orderform.js';
import { appendToTracker } from '../lib/tracker.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

// Stripe signature verification needs the raw bytes, not a parsed object.
export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end();
  }

  let event;
  try {
    const raw = await readRawBody(req);
    event = stripe.webhooks.constructEvent(
      raw,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('[webhook] signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await onSetupComplete(event.data.object);
        break;

      case 'customer.subscription.deleted':
        await onSubscriptionCancelled(event.data.object);
        break;

      default:
        break;
    }
  } catch (err) {
    // Non-2xx makes Stripe retry, which is what we want for a transient failure.
    console.error(`[webhook] handler failed for ${event.type}:`, err);
    return res.status(500).json({ received: false });
  }

  return res.status(200).json({ received: true });
}

/**
 * The card has been vaulted. Nothing is charged — this only completes onboarding:
 * pin the payment method as the customer default, generate the service agreement,
 * send it with the welcome email, and log the store to the tracker.
 *
 * Billing starts later, when api/activate.js is called on go-live.
 */
async function onSetupComplete(session) {
  const submissionId = session.client_reference_id || session.metadata?.submission_id;
  if (!submissionId) {
    console.error('[webhook] session has no submission id', session.id);
    return;
  }

  const submission = await getSubmission(submissionId);
  if (!submission) {
    console.error('[webhook] submission not found:', submissionId);
    return;
  }

  // Stripe retries on failure; sending the agreement twice is worse than late.
  if (submission.welcomeEmailSentAt) return;

  /* --- pin the vaulted card as the default --- */
  let paymentMethodId = null;
  if (session.setup_intent) {
    const intent = await stripe.setupIntents.retrieve(
      typeof session.setup_intent === 'string' ? session.setup_intent : session.setup_intent.id
    );
    paymentMethodId = typeof intent.payment_method === 'string'
      ? intent.payment_method
      : intent.payment_method?.id || null;

    if (paymentMethodId && submission.stripeCustomerId) {
      await stripe.customers.update(submission.stripeCustomerId, {
        invoice_settings: { default_payment_method: paymentMethodId }
      });
    }
  }

  const contact = {
    ...submission.contact,
    email: session.customer_details?.email || submission.contact?.email
  };

  const enriched = { ...submission, contact, paymentMethodId, status: 'onboarded' };

  /* --- order form --- */
  let attachments = [];
  let agreementSentAt = null;
  try {
    const pdf = await buildOrderForm(enriched);
    const safeName = String(enriched.profile?.storeName?.value || 'store')
      .replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 48);
    attachments = [{
      filename: `Poof-Order-Form-${safeName}.pdf`,
      content: pdf.toString('base64')
    }];
    agreementSentAt = new Date().toISOString();
  } catch (err) {
    // A failed PDF must not cost the retailer their welcome email.
    console.error('[webhook] order form generation failed:', err.message);
  }

  await sendWelcomeEmail({
    contact,
    profile: submission.profile,
    stack: submission.stack || {},
    referral: submission.referral || null,
    locationCount: submission.confirmedLocations?.length || submission.locationCount || 1,
    attachments
  });

  // Same order form, second recipient: the internal inbox Bazif works from.
  await sendOrderFormToOps(enriched, attachments).catch(err =>
    console.error('[webhook] ops notification failed:', err.message));

  const patch = {
    status: 'onboarded',
    paymentMethodId,
    welcomeEmailSentAt: new Date().toISOString(),
    agreementSentAt,
    orderFormVersion: agreementSentAt ? ORDER_FORM_VERSION : null
  };
  await markSubmission(submissionId, patch);

  await appendToTracker({ ...enriched, ...patch }).catch(err =>
    console.error('[webhook] tracker append failed:', err.message));

  await syncToHubspot({ submission: enriched, contact }).catch(err =>
    console.error('[webhook] hubspot sync failed:', err.message));
}

async function onSubscriptionCancelled(subscription) {
  const submissionId = subscription.metadata?.submission_id;
  if (!submissionId) return;
  const patch = { status: 'cancelled', cancelledAt: new Date().toISOString() };
  const updated = await markSubmission(submissionId, patch);
  if (updated) await appendToTracker(updated).catch(() => {});
}

/** Optional: push the retailer into HubSpot so sales sees the signup immediately. */
async function syncToHubspot({ submission, contact }) {
  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token) return;

  const [firstname, ...rest] = (contact.name || '').split(' ');
  const stack = submission.stack || {};

  await fetch('https://api.hubapi.com/crm/v3/objects/contacts', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      properties: {
        email: contact.email,
        firstname: firstname || '',
        lastname: rest.join(' '),
        phone: contact.phone || '',
        company: submission.profile?.storeName?.value || '',
        website: submission.profile?.website?.value || '',
        lifecyclestage: 'opportunity',
        poof_goals: (submission.goals || []).join(';'),
        poof_pos: stack.pos || '',
        poof_payment_processor: stack.payment || '',
        poof_delivery_software: stack.deliverySoftware || '',
        poof_referral_brand: submission.referral?.brand || '',
        poof_stripe_customer: submission.stripeCustomerId || ''
      }
    })
  });
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
