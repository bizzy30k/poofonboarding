/**
 * email.js — transactional welcome email.
 *
 * Uses Resend. Swap the send() body for Postmark/SES if you'd rather; the
 * template functions are provider-agnostic.
 */

const FROM = process.env.WELCOME_EMAIL_FROM || 'Poof <hello@poof.ca>';
const REPLY_TO = process.env.WELCOME_EMAIL_REPLY_TO || 'baz@poof.ca';
const DASHBOARD_URL = process.env.DASHBOARD_URL || 'https://business.poof.ca';
const REP_CC = process.env.REP_CC_EMAIL || '';   // no cc — the founder email is already from Bazif
const ONBOARDING_INBOX = process.env.ONBOARDING_INBOX || 'baz@poof.ca';
const FOUNDER_FROM = process.env.FOUNDER_EMAIL_FROM || 'Bazif Khan <baz@poof.ca>';
const FOUNDER_NAME = process.env.FOUNDER_NAME || 'Bazif';
const CALL_BOOKING_URL = process.env.CALL_BOOKING_URL || 'https://calendly.com/baz-poof/30min';

/**
 * The single retailer-facing email at signup — from the founder, not a system
 * address, with the account manager copied.
 *
 * It replaces the generic receipt deliberately: two automated emails landing in
 * the same minute dilute each other, and this one does the receipt's job
 * (confirmation, order form, nothing charged) while also carrying the one ask
 * that matters most — the retailer's shelf.
 */
export async function sendWelcomeEmail({ contact, profile, stack = {}, referral = null, attachments = [], locationCount = 1 }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('[email] RESEND_API_KEY missing — founder email skipped.');
    return { skipped: true };
  }

  const storeName = profile?.storeName?.value || 'your store';
  const firstName = (contact.name || '').split(' ')[0] || null;
  const partners = partnerNames(stack);

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: FOUNDER_FROM,
        to: [contact.email],
        cc: REP_CC ? [REP_CC] : undefined,
        reply_to: FOUNDER_FROM,
        subject: `Welcome to the Poof marketplace, ${storeName}`,
        html: founderHtml({ firstName, storeName, partners, referral, locationCount }),
        text: founderText({ firstName, storeName, partners, referral, locationCount }),
        attachments,
        tags: [
          { name: 'flow', value: 'retailer_onboarding' },
          { name: 'referred', value: referral ? 'yes' : 'no' }
        ]
      })
    });
    if (!res.ok) {
      console.error('[email] send failed:', res.status, await res.text());
      return { ok: false };
    }
    return { ok: true, id: (await res.json()).id };
  } catch (err) {
    console.error('[email]', err);
    return { ok: false };
  }
}

/** The retailer's own providers, named back to them. */
function partnerNames(stack) {
  const POS = { cova: 'Cova', greenline: 'Greenline' };
  const PAY = { merrco: 'Merrco', moneris: 'Moneris', covapay: 'CovaPay', blazepay: 'BlazePay' };
  const ECOM = { buddi: 'Buddi', dutchie: 'Dutchie', breadstack: 'Breadstack' };
  const DEL = { canfleet: 'Canfleet', onfleet: 'Onfleet' };
  const list = [
    stack.posOther || POS[stack.pos],
    stack.paymentOther || PAY[stack.payment],
    stack.ecommerce && stack.ecommerce !== 'none' ? (stack.ecommerceOther || ECOM[stack.ecommerce]) : null,
    stack.delivers && stack.deliverySoftware !== 'in_house'
      ? (stack.deliveryOther || DEL[stack.deliverySoftware]) : null
  ].filter(Boolean);
  const clean = [...new Set(list)];
  if (!clean.length) return 'your POS and payment providers';
  if (clean.length === 1) return clean[0];
  return clean.slice(0, -1).join(', ') + ' and ' + clean[clean.length - 1];
}

const P = 'margin:0 0 15px;font-size:16px;line-height:1.62;color:#3A3A44;';

function founderHtml({ firstName, storeName, partners, referral, locationCount }) {
  const doors = locationCount === 1 ? 'your store' : `all ${locationCount} of your stores`;
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#F6F6F8;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F6F6F8;padding:40px 16px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border:1px solid #E8E8EE;border-radius:20px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">

  <tr><td style="padding:34px 34px 0;">
    <div style="font-size:26px;font-weight:700;letter-spacing:-.03em;color:#0F0F12;">poof<span style="color:#FF428A;">.</span></div>
  </td></tr>

  <tr><td style="padding:24px 34px 0;">
    <h1 style="margin:0 0 16px;font-size:25px;line-height:1.25;color:#0F0F12;font-weight:600;letter-spacing:-.02em;">
      Welcome to the marketplace.
    </h1>
    <p style="${P}">
      ${firstName ? escapeHtml(firstName) + ', thank' : 'Thank'} you for joining the platform. I'm
      ${escapeHtml(FOUNDER_NAME)}, I founded Poof, and I'm excited to change the way brands work with you.
    </p>
    <p style="margin:0 0 15px;font-size:17px;line-height:1.6;color:#0F0F12;">
      For the past few years brands have been paying to get <strong>onto</strong> your shelf.
      Now they're going to pay to move product <strong>off</strong> it.
    </p>
    <p style="${P}">
      That's what ${escapeHtml(doors)} ${locationCount === 1 ? 'is' : 'are'} now set up for —
      <strong style="color:#0F0F12;">brand-funded demand</strong>, paid for by the brands you already
      carry, routed to you, fulfilled by your store at your prices.
    </p>
    <p style="${P}">Here's what the next steps look like.</p>
  </td></tr>

  <tr><td style="padding:6px 34px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr><td style="padding:14px 0;border-top:1px solid #E8E8EE;">
        <div style="font-size:12px;letter-spacing:.13em;text-transform:uppercase;color:#B77EFC;font-weight:700;">Next steps</div>
        <div style="font-size:17px;font-weight:600;color:#0F0F12;margin:6px 0 5px;">We contact ${escapeHtml(partners)}</div>
        <div style="font-size:15px;line-height:1.6;color:#3A3A44;">
          We ask them to connect your POS to Poof so orders route straight into your system.
          <strong style="color:#0F0F12;">You're copied on every message</strong> — nothing happens without you seeing it.
        </div>
      </td></tr>

      <tr><td style="padding:14px 0;border-top:1px solid #E8E8EE;">
        <div style="font-size:12px;letter-spacing:.13em;text-transform:uppercase;color:#FF428A;font-weight:700;">I need one thing from you</div>
        <div style="font-size:17px;font-weight:600;color:#0F0F12;margin:6px 0 5px;">Tell me what's on your shelf</div>
        <div style="font-size:15px;line-height:1.6;color:#3A3A44;">
          Just hit reply with the brands you reorder every month — five or ten is plenty, no format needed.
          We go to those brands directly and build sell-through with your store as the destination.
        </div>
      </td></tr>

      <tr><td style="padding:14px 0;border-top:1px solid #E8E8EE;">
        <div style="font-size:12px;letter-spacing:.13em;text-transform:uppercase;color:#489CFC;font-weight:700;">This week, if you can</div>
        <div style="font-size:17px;font-weight:600;color:#0F0F12;margin:6px 0 5px;">We get on a call</div>
        <div style="font-size:15px;line-height:1.6;color:#3A3A44;">
          Half an hour — what to expect, which brands we're running campaigns with right now,
          and where your stores sit in their coverage. Grab a slot this week and we can go live
          as soon as your systems are connected.
        </div>
      </td></tr>
    </table>
  </td></tr>

  <tr><td style="padding:24px 34px 0;">
    <a href="${CALL_BOOKING_URL}" style="display:inline-block;background:#FF428A;color:#FCFCFC;text-decoration:none;font-weight:600;font-size:16px;padding:15px 30px;border-radius:999px;">
      Book your call
    </a>
  </td></tr>

  <tr><td style="padding:24px 34px 0;">
    <table role="presentation" width="100%" style="background:#F6F6F8;border:1px solid #E8E8EE;border-radius:12px;">
      <tr><td style="padding:15px 17px;font-size:14.5px;line-height:1.55;color:#3A3A44;">
        Your order form is attached. <strong style="color:#0F0F12;">Nothing has been charged.</strong>
        ${referral
          ? `Your ${referral.monthsCredited || 3}-month credit from ${escapeHtml(referral.brand)} starts the day you go live.`
          : 'Billing starts only once you\'re live and you\'ve approved it, and it stays month to month.'}
      </td></tr>
    </table>
  </td></tr>

  <tr><td style="padding:26px 34px 34px;">
    <p style="${P}">Reply straight to this — it comes to me.</p>
    <p style="margin:0;font-size:16px;line-height:1.5;color:#0F0F12;">
      <strong>${escapeHtml(FOUNDER_NAME)}</strong><br>
      <span style="font-size:14px;color:#74747C;">Founder, Poof Technologies</span>
    </p>
  </td></tr>

  <tr><td style="padding:18px 34px;border-top:1px solid #E8E8EE;background:#FCFCFC;">
    <p style="margin:0;font-size:12px;color:#74747C;">
      Poof Technologies Inc. · Toronto, Ontario ·
      <a href="${DASHBOARD_URL}" style="color:#C4126A;text-decoration:none;">business.poof.ca</a>
    </p>
  </td></tr>

</table>
</td></tr></table>
</body></html>`;
}

function founderText({ firstName, storeName, partners, referral, locationCount }) {
  const doors = locationCount === 1 ? 'your store' : `all ${locationCount} of your stores`;
  return [
    'Welcome to the marketplace.',
    '',
    `${firstName ? firstName + ', thank' : 'Thank'} you for joining the platform. I'm ${FOUNDER_NAME}, I founded Poof, and I'm excited to change the way brands work with you.`,
    '',
    "For the past few years brands have been paying to get ONTO your shelf. Now they're going to pay to move product OFF it.",
    '',
    `That's what ${doors} ${locationCount === 1 ? 'is' : 'are'} now set up for — brand-funded demand, paid for by the brands you already carry, routed to you, fulfilled by your store at your prices.`,
    '',
    "Here's what the next steps look like.",
    '',
    `NEXT STEPS — We contact ${partners}`,
    'We ask them to connect your POS to Poof so orders route straight into your system. You are copied on every message.',
    '',
    'I NEED ONE THING FROM YOU — Tell me what\'s on your shelf',
    'Hit reply with the brands you reorder every month. Five or ten is plenty, no format needed. We go to those brands directly and build sell-through with your store as the destination.',
    '',
    'THIS WEEK, IF YOU CAN — We get on a call',
    `Half an hour: what to expect, which brands we're running campaigns with right now, and where your stores sit in their coverage. Grab a slot this week and we can go live as soon as your systems are connected: ${CALL_BOOKING_URL}`,
    '',
    referral
      ? `Your order form is attached. Nothing has been charged. Your ${referral.monthsCredited || 3}-month credit from ${referral.brand} starts the day you go live.`
      : "Your order form is attached. Nothing has been charged. Billing starts only once you're live and you've approved it, and it stays month to month.",
    '',
    'Reply straight to this — it comes to me.',
    '',
    FOUNDER_NAME,
    'Founder, Poof Technologies'
  ].join('\n');
}

/* ------------------------------------------------------------------ *
 * Go-live notice — sent by api/activate.js when billing starts
 * ------------------------------------------------------------------ */

/**
 * The one email the retailer must not be surprised by. Signup promised no charge
 * until go-live; this is the notice that go-live has happened and billing has
 * begun. Send it on activation, not after the first invoice.
 */
export async function sendGoLiveEmail(submission) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('[email] RESEND_API_KEY missing — go-live email skipped.');
    return { skipped: true };
  }

  const contact = submission.contact || {};
  const storeName = submission.profile?.storeName?.value || 'your store';
  const referral = submission.referral;
  const firstName = (contact.name || '').split(' ')[0] || null;

  const billingLine = referral?.monthsCredited
    ? `Your ${referral.monthsCredited}-month credit from ${referral.brand} starts today, so there's nothing to pay until it runs out.`
    : 'Billing on the card you have on file starts today.';

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: FROM,
        to: [contact.email],
        reply_to: REPLY_TO,
        subject: `${storeName} is live on the Poof Retail Network`,
        html: `<!doctype html><html><body style="margin:0;background:#08080A;">
<table role="presentation" width="100%" style="background:#08080A;padding:40px 16px;"><tr><td align="center">
<table role="presentation" width="100%" style="max-width:520px;background:#111014;border:1px solid #232326;border-radius:16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <tr><td style="padding:32px 32px 8px;">
    <div style="font-size:13px;letter-spacing:.18em;text-transform:uppercase;color:#FF3D8B;font-weight:700;">You're live</div>
  </td></tr>
  <tr><td style="padding:8px 32px 0;">
    <h1 style="margin:0;font-size:26px;line-height:1.25;color:#F7F7F8;font-weight:600;">${escapeHtml(storeName)} is on the network.</h1>
    <p style="margin:12px 0 0;font-size:16px;line-height:1.6;color:#B4B4BC;">
      ${firstName ? escapeHtml(firstName) + ', as' : 'As'} of today, brand campaigns can route orders to your store.
    </p>
  </td></tr>
  <tr><td style="padding:20px 32px 0;">
    <table role="presentation" width="100%" style="background:rgba(255,255,255,.03);border:1px solid #232326;border-radius:10px;">
      <tr><td style="padding:14px 16px;font-size:14px;line-height:1.55;color:#B4B4BC;">${escapeHtml(billingLine)}</td></tr>
    </table>
  </td></tr>
  <tr><td style="padding:26px 32px 32px;">
    <a href="${DASHBOARD_URL}" style="display:inline-block;background:#FF3D8B;color:#08080A;text-decoration:none;font-weight:700;font-size:15px;padding:13px 26px;border-radius:9px;">Open your dashboard</a>
  </td></tr>
  <tr><td style="padding:18px 32px;border-top:1px solid #232326;">
    <p style="margin:0;font-size:12px;color:#46464E;">Poof Technologies · Ontario, Canada</p>
  </td></tr>
</table></td></tr></table></body></html>`,
        text: [
          `${storeName} is live on the Poof Retail Network.`,
          '',
          `${firstName ? firstName + ', as' : 'As'} of today, brand campaigns can route orders to your store.`,
          '',
          billingLine,
          '',
          `Open your dashboard: ${DASHBOARD_URL}`
        ].join('\n'),
        tags: [{ name: 'flow', value: 'retailer_golive' }]
      })
    });
    if (!res.ok) {
      console.error('[email] go-live send failed:', res.status);
      return { ok: false };
    }
    return { ok: true };
  } catch (err) {
    console.error('[email] go-live', err);
    return { ok: false };
  }
}

/* ------------------------------------------------------------------ *
 * Internal order form → Bazif
 * ------------------------------------------------------------------ */

/**
 * Everything captured during onboarding, in the body so it's searchable in the
 * inbox, with the order form PDF attached. The retailer accepts the agreement
 * electronically during the flow, so the attached order form is the executed
 * record — there is no separate signature step to chase.
 *
 * Note what is deliberately absent: no API keys, no credentials. Those are
 * requested from the integration partners after the agreement is signed, with
 * the retailer copied — never collected here.
 */
export async function sendOrderFormToOps(submission, attachments = []) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('[email] RESEND_API_KEY missing — ops notification skipped.');
    return { skipped: true };
  }

  const p = submission.profile || {};
  const stack = submission.stack || {};
  const contact = submission.contact || {};
  const locs = submission.confirmedLocations?.length
    ? submission.confirmedLocations
    : (p.locations || []);
  const monthly = locs.length * 50;

  const row = (k, v) => v
    ? `<tr><td style="padding:6px 14px 6px 0;color:#74747C;font-size:13px;vertical-align:top;white-space:nowrap;">${escapeHtml(k)}</td>
         <td style="padding:6px 0;color:#0F0F12;font-size:14px;">${v}</td></tr>`
    : '';

  const partners = [
    stack.pos === 'cova' ? 'Cova' : stack.pos === 'greenline' ? 'Greenline' : stack.posOther,
    { merrco: 'Merrco', moneris: 'Moneris', covapay: 'CovaPay', blazepay: 'BlazePay' }[stack.payment] || stack.paymentOther,
    stack.ecommerce && stack.ecommerce !== 'none' ? (stack.ecommerceOther || { buddi:'Buddi', dutchie:'Dutchie', breadstack:'Breadstack' }[stack.ecommerce]) : null,
    stack.delivers && stack.deliverySoftware === 'canfleet' ? 'Canfleet' : null
  ].filter(Boolean);

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: FROM,
        to: [ONBOARDING_INBOX],
        cc: REP_CC ? [REP_CC] : undefined,
        reply_to: contact.email,
        subject: `New signup — ${p.storeName?.value || 'store'} (${locs.length} location${locs.length === 1 ? '' : 's'}, $${monthly}/mo)`,
        html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;max-width:640px;">
  <h2 style="margin:0 0 4px;font-size:20px;color:#0F0F12;">${escapeHtml(p.storeName?.value || '')}</h2>
  <p style="margin:0 0 18px;color:#74747C;font-size:13px;">Order ${escapeHtml(submission.id || '')} · ${new Date().toLocaleString('en-CA')}</p>

  <table style="border-collapse:collapse;width:100%;">
    ${row('Contact', `${escapeHtml(contact.name || '')} · <a href="mailto:${escapeHtml(contact.email || '')}">${escapeHtml(contact.email || '')}</a>${contact.phone ? ' · ' + escapeHtml(contact.phone) : ''}`)}
    ${row('Locations', `${locs.length} — ${escapeHtml([...new Set(locs.map(l => l.name))].join(', '))}`)}
    ${row('Licences', escapeHtml(locs.map(l => l.licenceNumber).filter(Boolean).join(', ')))}
    ${row('AGCO status', escapeHtml(p.status?.overall || ''))}
    ${row('Hours', escapeHtml(p.hours?.prose || ''))}
    ${row('Phone', escapeHtml(p.phone?.value || ''))}
    ${row('Website', p.website?.value ? `<a href="${escapeHtml(p.website.value)}">${escapeHtml(p.website.value)}</a>` : '')}
  </table>

  <h3 style="margin:22px 0 6px;font-size:14px;color:#0F0F12;">Systems</h3>
  <table style="border-collapse:collapse;width:100%;">
    ${row('POS', escapeHtml(stack.posOther || { cova: 'Cova', greenline: 'Greenline' }[stack.pos] || stack.pos || '—'))}
    ${row('Processor', escapeHtml(stack.paymentOther || { merrco: 'Merrco', moneris: 'Moneris', covapay: 'CovaPay', blazepay: 'BlazePay' }[stack.payment] || stack.payment || '—'))}
    ${row('E-commerce', escapeHtml(stack.ecommerceOther || { buddi:'Buddi', dutchie:'Dutchie', breadstack:'Breadstack', none:'Just their POS menu' }[stack.ecommerce] || '—'))}
    ${row('Delivery', stack.delivers
      ? escapeHtml(stack.deliveryOther || stack.deliverySoftware || 'yes')
      : stack.wantsDelivery ? '<strong>No — wants to offer it</strong>' : 'No')}
  </table>

  <h3 style="margin:22px 0 6px;font-size:14px;color:#0F0F12;">Commercials</h3>
  <table style="border-collapse:collapse;width:100%;">
    ${row('Retail Ad Network', `${locs.length} × $50.00 = <strong>$${monthly.toFixed(2)}</strong>/mo + HST`)}
    ${row('Referral', submission.referral ? `${escapeHtml(submission.referral.code)} — ${escapeHtml(submission.referral.brand)}, ${submission.referral.monthsCredited || 3} months` : 'None')}
    ${row('Stripe customer', escapeHtml(submission.stripeCustomerId || ''))}
    ${row('Card on file', submission.paymentMethodId ? 'Yes — not charged' : 'No')}
    ${row('Terms accepted', submission.acceptance
      ? `<strong>${escapeHtml(submission.acceptance.acceptedBy)}</strong>${submission.acceptance.acceptedTitle ? ', ' + escapeHtml(submission.acceptance.acceptedTitle) : ''}
         — ${new Date(submission.acceptance.acceptedAt).toLocaleString('en-CA')}
         · v${escapeHtml(submission.acceptance.termsVersion || '')}${submission.acceptance.ip ? ' · ' + escapeHtml(submission.acceptance.ip) : ''}`
      : 'Not recorded')}
  </table>

  <div style="margin:24px 0 0;padding:14px 16px;background:#F6F6F8;border:1px solid #E8E8EE;border-radius:12px;font-size:13.5px;color:#44444C;line-height:1.6;">
    <strong style="color:#0F0F12;">Next steps</strong><br>
    1. Agreement already accepted electronically — the attached order form is the executed record.<br>
    2. Once signed, contact ${partners.length ? escapeHtml(partners.join(', ')) : 'the integration partners'} with the retailer copied, to request integration details.<br>
    3. Configure Poof HQ, send login credentials, then activate billing.
  </div>
</div>`,
        attachments,
        tags: [{ name: 'flow', value: 'ops_order_form' }]
      })
    });
    if (!res.ok) {
      console.error('[email] ops notification failed:', res.status);
      return { ok: false };
    }
    return { ok: true };
  } catch (err) {
    console.error('[email] ops', err);
    return { ok: false };
  }
}
