// Email. The retailer gets their order form (PDF attached) from here, and the onboarding inbox
// gets an internal notification. Sends through SendGrid if SENDGRID_API_KEY is set, else Resend if
// RESEND_API_KEY is set. The internal notification uses the same provider, so a
// signup never goes unnoticed even if neither is configured yet.
const config = require('./config');
const sec = require('./security');

function parseFrom(from) { const m = String(from).match(/^\s*(.*?)\s*<([^>]+)>\s*$/); return m ? { name: m[1].replace(/^"|"$/g, ''), email: m[2] } : { email: String(from).trim() }; }

async function sendgrid({ to, cc, bcc, subject, html, attachments }) {
  const r = await sec.fetchT('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.SENDGRID_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: to.map(email => ({ email })), ...(cc && cc.length ? { cc: cc.map(email => ({ email })) } : {}), ...(bcc && bcc.length ? { bcc: bcc.map(email => ({ email })) } : {}) }],
      from: parseFrom(config.SENDER_EMAIL),
      reply_to: { email: config.SENDER_REPLY_TO || parseFrom(config.SENDER_EMAIL).email },
      subject,
      content: [{ type: 'text/html', value: html }],
      // No link rewriting or open pixel: SendGrid's tracking domain has no HTTPS certificate, so rewritten
      // links showed a browser security warning, and tracked links also hurt inbox placement.
      tracking_settings: { click_tracking: { enable: false, enable_text: false }, open_tracking: { enable: false } },
      // SendGrid rejects an empty attachments array — only send the key when there is one.
      ...(attachments && attachments.length
        ? { attachments: attachments.map(a => ({ filename: a.filename, content: a.content, type: 'application/pdf', disposition: 'attachment' })) }
        : {}),
    }),
  });
  if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error('SendGrid: ' + r.status + ' ' + t.slice(0, 300)); }
  return { id: r.headers.get('x-message-id') || true, via: 'sendgrid' };
}

async function resendApi({ to, cc, subject, html, attachments }) {
  const r = await sec.fetchT('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: config.FROM_EMAIL, to, cc, subject, html, attachments }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Resend: ' + (j.message || r.status));
  return { ...j, via: 'resend' };
}

async function send(msg) {
  if (config.SENDGRID_API_KEY) return sendgrid(msg);
  if (config.RESEND_API_KEY) return resendApi(msg);
  return { skipped: 'no SENDGRID_API_KEY or RESEND_API_KEY' };
}

// Internal notification goes through the same provider as retailer mail (no third-party relay).
async function internalEmail(subject, fields, extraHtml = '') {
  const rows = Object.entries(fields).map(([k, v]) => `<tr><td style="padding:5px 10px 5px 0;color:#777;white-space:nowrap;vertical-align:top">${esc(k)}</td><td style="padding:5px 0">${esc(v == null ? '' : String(v))}</td></tr>`).join('');
  return send({ to: [config.ONBOARDING_INBOX], subject, html: `<!doctype html><body style="font-family:Helvetica,Arial,sans-serif;font-size:14px;color:#08080a"><table style="border-collapse:collapse">${rows}</table>${extraHtml}</body>` });
}

function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

const LIVE = { pos: new Set(['cova', 'greenline']), processor: new Set(['merrco', 'moneris']) };
function retailerHtml(record, orderFormUrl) {
  const n = record.locations.length;
  const tier = require('./offer').lines(record.offer);
  const ref = record.referral && (record.referral.months || record.referral.days) ? record.referral : null;
  const hasCard = !!record.paymentMethod && !record.cardSkipped;
  const pos = (record.systems && record.systems.pos) || '', proc = (record.systems && record.systems.processor) || '';
  const live = [LIVE.pos.has(pos.toLowerCase()) ? pos : null, LIVE.processor.has(proc.toLowerCase()) ? proc : null].filter(Boolean).join(' and ');
  const pending = [pos && !LIVE.pos.has(pos.toLowerCase()) ? pos : null, proc && !LIVE.processor.has(proc.toLowerCase()) ? proc : null].filter(Boolean).join(' and ');
  const first = String(record.owner.name || '').trim().split(/\s+/)[0];
  const lede = `Your agreement for <b>${esc(record.store.chainName)}</b> is signed${hasCard ? ' and your card is on file' : ''}. `
    + (tier ? `${esc(tier.headline)}. ${hasCard ? 'Your card was only saved, not charged.' : esc(tier.detail)}` : 'Nothing is charged until you approve your menu and go live.');
  const cell = 'padding:14px 16px;font-size:15px;border-bottom:1px solid #e4e4ea', label = 'padding:14px 16px;font-size:14px;color:#666672;border-bottom:1px solid #e4e4ea';
  const locs = record.locations.slice(0, 40).map(l => `<div style="font-size:13px;color:#666672;padding-top:4px">${esc(`${l.addr}, ${l.city}`)}</div>`).join('');
  const rows = [
    ['Store', esc(record.store.chainName)],
    ['Locations', `${n}${locs}`],
    ['Price', `$${n * config.PRICE_CAD}/month + HST${tier ? `, starting ${esc(tier.billingStarts)}` : ', from the day you go live'}`],
    tier ? ['Free period', `${esc(tier.headline)}${hasCard ? '' : `<div style="font-size:13px;color:#666672;padding-top:4px">${esc(tier.detail)}</div>`}`]
      : ref ? [`Your code ${esc(ref.code)}`, `${ref.days ? ref.days + ' days' : ref.months + ' months'} free from the day you go live${ref.until ? `, ending ${require('./promo').longDate(ref.until)} at the latest` : ''}`]
      : record.offer ? ['Launch offer', `${record.offer.months} months free, applied at go-live`] : null,
    ['Signed by', esc(`${record.acceptance.name}${record.acceptance.title ? ', ' + record.acceptance.title : ''}`)],
  ].filter(Boolean);
  const systems = `<tr><td style="padding:14px 16px;font-size:14px;color:#666672">Your systems</td><td style="padding:14px 16px;font-size:15px">${esc(pos || 'POS not provided')} · ${esc(proc || 'Processor not provided')}</td></tr>`;
  const steps = [
    'Our team reaches out within one business day to walk you through it.',
    live ? `We contact ${esc(live)} to connect your store, with you copied.` : null,
    pending ? `We're working on setting up the ${esc(pending)} integration. Please connect us with your representative to speed up the process.` : null,
    'Your admin login arrives with your menu configured, ready for your approval.',
    'You approve, we go live.',
  ].filter(Boolean);
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/><meta content="width=device-width, initial-scale=1" name="viewport"/><title>You're in</title></head><body style="margin:0;padding:0;background:#ffffff;font-family:Helvetica,Arial,sans-serif;color:#08080a"><table cellpadding="0" cellspacing="0" role="presentation" style="background:#ffffff" width="100%"><tr><td align="center" style="padding:28px 16px"><table cellpadding="0" cellspacing="0" role="presentation" style="max-width:560px;width:100%" width="560">
<tr><td style="padding:0 0 22px"><a href="https://business.poof.ca/" style="text-decoration:none"><img alt="poof." height="55" src="https://signup.poof.ca/poof-email-logo.gif" style="display:block;border:0;outline:none" width="180"/></a></td></tr>
<tr><td style="font-size:24px;line-height:1.25;font-weight:700;padding:0 0 10px">You're in${first ? ', ' + esc(first) : ''}.</td></tr>
<tr><td style="font-size:16px;line-height:1.55;color:#33333b;padding:0 0 22px">${lede}</td></tr>
<tr><td style="padding:0 0 26px"><a href="${orderFormUrl}" style="display:inline-block;background:#ff3d8b;color:#ffffff;text-decoration:none;font-weight:700;font-size:16px;border-radius:10px;padding:14px 26px">Download your order form</a><div style="font-size:13px;color:#777;padding-top:10px">Your order form is also attached as a PDF. It lists every location you added and the agreement you accepted. Keep it for your records.</div></td></tr>
<tr><td style="padding:0 0 26px"><table cellpadding="0" cellspacing="0" role="presentation" style="border:1px solid #e4e4ea;border-radius:10px" width="100%">${rows.map(([k, v]) => `<tr><td style="${label}" width="42%">${k}</td><td style="${cell}">${v}</td></tr>`).join('')}${systems}</table></td></tr>
<tr><td style="font-size:17px;font-weight:700;padding:0 0 10px">What happens next</td></tr>
<tr><td style="font-size:15px;line-height:1.6;color:#33333b;padding:0 0 22px"><ol style="margin:0;padding-left:20px">${steps.map(t => `<li style="padding-bottom:8px">${t}</li>`).join('')}</ol></td></tr>
<tr><td style="padding:0 0 26px"><table cellpadding="0" cellspacing="0" role="presentation" style="background:#f6f6f8;border-radius:10px" width="100%"><tr><td style="padding:16px 18px;font-size:15px;line-height:1.5;color:#33333b"><b>See it working.</b> Check out the case study we did for a group of retailers and one brand. <a href="https://business.poof.ca/blog/?type=case" style="color:#ff3d8b;font-weight:700">Read the case study</a></td></tr></table></td></tr>
<tr><td style="font-size:15px;line-height:1.55;color:#33333b;padding:0 0 26px">Questions? Reply to this email and our onboarding team will get back to you.</td></tr>
<tr><td style="border-top:1px solid #e4e4ea;padding:18px 0 0;font-size:12px;line-height:1.6;color:#8b8b96">${esc(config.COMPANY)}, ${esc(config.COMPANY_ADDR)}<br/>You're receiving this because you signed ${esc(record.store.chainName)} up with Poof. <a href="${config.TERMS_URL}" style="color:#8b8b96">Agreement and schedules</a></td></tr>
</table></td></tr></table></body></html>`;
}

async function sendSignupEmails(record, pdfBuffer, orderFormUrl) {
  const out = {};
  const n = record.locations.length;
  const subject = `You're in: your Poof order form for ${record.store.chainName}`;

  // 1. Retailer confirmation, with the order form attached. Sent from here through SendGrid
  //    (poof.ca is authenticated there). CONFIRMATION_VIA=klaviyo hands it back to the Klaviyo flow.
  const viaKlaviyo = config.CONFIRMATION_VIA === 'klaviyo' && !!config.KLAVIYO_API_KEY;
  if (viaKlaviyo) out.retailer = { id: 'klaviyo', via: 'klaviyo' };
  else try {
    out.retailer = await send({
      to: [record.owner.email],
      // SendGrid rejects the whole message if an address appears twice, so never copy the retailer's own address.
      // Blind copies, so the retailer does not see internal addresses.
      bcc: [...new Set((config.RETAILER_CC || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean))]
        .filter(a => a !== String(record.owner.email).trim().toLowerCase()),
      subject,
      html: retailerHtml(record, orderFormUrl),
      attachments: [{ filename: `Poof-Order-Form-${record.store.chainName.replace(/[^a-z0-9]+/gi, '-')}.pdf`, content: pdfBuffer.toString('base64') }],
    });
  } catch (e) { out.retailer = { error: e.message }; console.error('mail: retailer confirmation failed', e.message); }

  // 2. Internal notification to the onboarding inbox
  try {
    out.internal = await internalEmail(`New retailer signup — ${record.store.chainName} (${n})`, {
      'Store': record.store.chainName,
      'Locations': String(n),
      'Location IDs': record.locations.map(l => l.id).join(', '),
      'Poof HQ': record.locations.map(l => `${l.id} → ${record.hq && record.hq[l.id] ? record.hq[l.id].url : 'not in core'}`).join(' · '),
      'Groups': (record.groups || []).map(g => `${g.name} (${g.ids.length})`).join('; ') || 'none',
      'Contact': `${record.owner.name} · ${record.owner.email} · ${record.owner.mobile || ''}`,
      'POS': record.systems.pos, 'Processor': record.systems.processor,
      'E-commerce': record.systems.ecommerce || 'none',
      'Delivery': record.systems.delivery ? (record.systems.deliverySoftware || 'yes') : 'no',
      'Referral code': record.referral?.code ? `${record.referral.code}${record.referral.description ? ' — ' + record.referral.description : ''}` : 'none',
      'Source': record.source || 'onboarding.poof.ca',
      'Accepted by': `${record.acceptance.name}, ${record.acceptance.title} at ${record.acceptance.at} from ${record.acceptance.ip}`,
      'Terms version': record.acceptance.termsVersion,
      'Card on file': record.cardSkipped ? 'NO — collect on setup call' : 'yes',
      'Launch offer': record.offer ? record.offer.code : 'none',
      'Entry store': record.entryStoreId || '',
      'FRANCHISE CONFLICT': (record.conflicts || []).length ? record.conflicts.map(c => `${c.overlapCount || (c.overlap || []).length} door(s) also on ${c.customerId} (${c.stage})`).join('; ') : 'none',
      'Stripe customer': record.customerId,
      'Setup intent': record.setupIntent,
      'Order form': orderFormUrl,
      'Retailer email sent': viaKlaviyo ? 'by Klaviyo (signup confirmation flow)' : out.retailer && out.retailer.id ? 'yes' : ('NO — ' + JSON.stringify(out.retailer)),
    });
  } catch (e) { out.internal = { error: e.message }; }
  return out;
}

// ---- Listing claims (lib/claims.js) --------------------------------------------------------

const shell = (inner) => `<!doctype html><body style="font-family:Helvetica,Arial,sans-serif;color:#08080a;max-width:560px;margin:0 auto;padding:24px">
  <p style="font-size:22px;font-weight:700;margin:0 0 18px">poof<span style="color:#ff3d8b">.</span></p>${inner}
  <p style="font-size:12px;color:#999;line-height:1.5;margin-top:28px">${esc(config.COMPANY)} · ${esc(config.COMPANY_ADDR)}<br>Questions: reply to this e-mail or write to onboarding@pooftechnologies.ca.</p></body>`;

const button = (href, label) => `<p style="margin:22px 0"><a href="${href}" style="display:inline-block;background:#08080a;color:#fff;text-decoration:none;font-weight:600;border-radius:999px;padding:12px 22px">${esc(label)}</a></p>`;

const claims = require('./claims');
// Every link in a retailer email carries UTMs so GA4 can attribute the POS click / signup to the email it came from.
const utm = (url, campaign, content) => `${url}${url.includes('?') ? '&' : '?'}utm_source=sendgrid&utm_medium=email&utm_campaign=${campaign}${content ? `&utm_content=${content}` : ''}`;
const editUrl = (id, token) => utm(`${config.SITE_URL}/claim/${id}?t=${token}`, 'claim-received', 'edit');
const moreUrl = (id, token) => utm(`${config.SITE_URL}/claim/${id}?t=${token}&more=1`, 'claim-received', 'claim-more');
const hoursLine = (h) => h ? Object.entries(h).map(([d, x]) => `${d.slice(0, 3)} ${x ? `${x.open}–${x.close}` : 'closed'}`).join(', ') : 'not provided';

/** Email 1 — sent the moment the owner presses "Finalise details". Copy is fixed; do not reword. */
function claimReceivedHtml(rec, o = {}) {
  // The POS link carries the edit token so the signup can prefill name + email and start at pricing.
  const pos = utm(`${config.SITE_URL}/s/${rec.id}${o.token ? `?t=${o.token}` : ''}`, 'claim-received', 'pos');
  const more = o.siblings > 0 && o.token
    ? `<p style="margin:22px 0 6px;line-height:1.5">You have <b>${o.siblings} more ${esc(rec.storeName)} ${o.siblings === 1 ? 'location' : 'locations'}</b> on Poof. Use the same logo and details for ${o.siblings === 1 ? 'it' : 'all of them'} in one click:</p>${button(moreUrl(rec.id, o.token), `Claim your other ${o.siblings} ${o.siblings === 1 ? 'location' : 'locations'}`)}`
    : '';
  const logo = o.logoLater ? `<p style="margin:14px 0;line-height:1.5"><b>One thing missing: your logo.</b> Reply to this email with it attached (PNG or JPG) and we'll add it before the listing goes live.</p>` : '';
  const edit = o.token ? `<p style="font-size:13px;color:#777;line-height:1.5">Need to change something? <a href="${editUrl(rec.id, o.token)}" style="color:#ff3d8b">Edit your listing</a> — this link is yours alone; don't forward it.</p>` : '';
  return shell(`
  <p style="font-size:16px;margin:0 0 14px;line-height:1.5">We received your update — live within one business day.</p>
  <p style="margin:0 0 14px;line-height:1.5">Our team is reviewing your submission now. If everything looks correct, you'll receive an email confirming the approval and the update on the marketplace.</p>
  <p style="margin:0 0 6px;line-height:1.5">In the meantime, if you are interested in connecting your point-of-sale system, follow this link:</p>
  ${button(pos, 'Connect your point-of-sale system')}${logo}${more}${edit}
  <p style="font-size:13px;color:#777;line-height:1.5">${esc(rec.storeName)} · ${esc(rec.location ? rec.location.name : rec.id)} · ${esc(rec.id)}</p>`);
}

/** Email 2 — sent when the listing is approved and live (POST /api/claims action=publish). */
function claimLiveHtml(rec, liveUrl) {
  const pos = utm(`${config.SITE_URL}/s/${rec.id}?t=${claims.editToken(rec.id, rec.contact.email)}`, 'listing-live', 'pos');
  liveUrl = utm(liveUrl, 'listing-live', 'listing');
  return shell(`
  <p style="font-size:16px;margin:0 0 14px;line-height:1.5">${esc(rec.storeName)} is live on Poof.</p>
  <p style="margin:0 0 6px;line-height:1.5">Your updated listing is up on the marketplace — have a look:</p>
  ${button(liveUrl, 'See your listing')}
  <p style="margin:0 0 6px;line-height:1.5">Right now shoppers can find you. Connect your point-of-sale system and they can buy from you too — your live menu, stock and deals, on the marketplace and in every brand campaign we run.</p>
  ${button(pos, 'Connect your point-of-sale system')}`);
}

/** Email 3 — "claim the rest": one email listing every location just claimed. */
function claimBulkHtml(src, recs, o = {}) {
  const pos = utm(`${config.SITE_URL}/s/${src.id}?also=${recs.map(r => r.id).join(',')}${o.token ? `&t=${o.token}` : ''}`, 'claim-bulk', 'pos');
  const rows = recs.map(r => `<tr><td style="padding:6px 0;border-bottom:1px solid #eee">${esc(r.location.name)}<br><span style="color:#777;font-size:12px">${esc(r.location.addr)}, ${esc(r.location.city)}</span></td><td style="padding:6px 0;border-bottom:1px solid #eee;text-align:right;white-space:nowrap"><a href="${editUrl(r.id, claims.editToken(r.id, r.contact.email))}" style="color:#ff3d8b;font-size:13px">Edit</a></td></tr>`).join('');
  return shell(`
  <p style="font-size:16px;margin:0 0 14px;line-height:1.5">Awesome. ${recs.length === 1 ? 'That location has' : `All ${recs.length} locations have`} been updated.</p>
  <p style="margin:0 0 14px;line-height:1.5">Same logo, website and description as ${esc(src.location ? src.location.name : src.storeName)}; phone and hours from Google for each store. Each one should be live in 1 business day — we'll email you to have a look. If any phone number or hours look off, press Edit next to that store.</p>
  <table style="border-collapse:collapse;width:100%;font-size:14px">${rows}</table>
  <p style="margin:22px 0 6px;line-height:1.5">If you are interested in connecting your point-of-sale system for ${recs.length === 1 ? 'both stores' : 'all your stores'}, follow this link:</p>
  ${button(pos, 'Connect your point-of-sale system')}
  <p style="font-size:13px;color:#777;line-height:1.5">The Edit links are yours alone; don't forward them.</p>`);
}

function internalClaimExtra(rec, coreListing) {
  const l = rec.listing;
  return `<p style="margin:18px 0 6px;font-weight:700">Logo</p>${l.logoUrl ? `<p><a href="${l.logoUrl}">${esc(l.logoUrl)}</a><br><img src="${l.logoUrl}" alt="" style="max-width:160px;max-height:160px;border:1px solid #eee;border-radius:12px;margin-top:8px"></p>` : '<p>not uploaded</p>'}
<p style="margin:18px 0 6px;font-weight:700">Core fields (paste into the HQ store record)</p><pre style="background:#f6f6f8;padding:12px;border-radius:8px;font-size:12px;white-space:pre-wrap">${esc(JSON.stringify(coreListing, null, 2))}</pre>
<p style="margin:18px 0 6px;font-weight:700">Approve</p><p style="font-size:13px;line-height:1.5">Once it's in HQ, publish it (sends the "it's live" email):<br><code>curl -X POST ${config.SITE_URL}/api/claims -H "x-admin-key: $ADMIN_KEY" -H "content-type: application/json" -d '{"action":"publish","id":"${rec.id}","url":"https://poof.ca/..."}'</code><br><br>Not the owner? Release it so the real one can claim:<br><code>curl -X POST ${config.SITE_URL}/api/claims -H "x-admin-key: $ADMIN_KEY" -H "content-type: application/json" -d '{"action":"release","id":"${rec.id}"}'</code></p>`;
}

async function sendClaimEmails(rec, coreListing, o = {}) {
  const out = {};
  try {
    out.retailer = await send({ to: [rec.contact.email], subject: `Your ${rec.storeName} listing on Poof has been updated`, html: claimReceivedHtml(rec, o) });
  } catch (e) { out.retailer = { error: e.message }; }
  try {
    const l = rec.listing;
    const own = claims.ownership(rec, o.google);
    out.internal = await internalEmail(`Listing claimed — ${rec.storeName} · ${rec.location ? rec.location.city : rec.id} [${own.verdict}]`, {
      'Ownership': own.line,
      'Store': `${rec.storeName} — ${rec.location ? rec.location.name : ''}`, 'CRSA': rec.id, 'Chain': rec.chain || '',
      'Poof HQ': rec.hq ? `${rec.hq.url}${rec.hq.matched === 'address' ? ' (matched by address — check)' : ''}` : 'not found in core — add the store in HQ first',
      'Claimed by': `${rec.contact.name} · ${rec.contact.email}${rec.editor ? ` (edited by ${rec.editor.name} · ${rec.editor.email})` : ''}`,
      'Phone': l.phone || '', 'Google phone': o.google && o.google.phone ? o.google.phone : '—',
      'Public email': l.email || '', 'Website': l.website || '', 'Google website': o.google && o.google.website ? o.google.website : '—',
      'Instagram': l.instagram ? '@' + l.instagram : '',
      'Description': l.description || '', 'Hours': hoursLine(l.hours),
      'Needs review': (rec.needsReview || []).join('; ') || 'nothing flagged',
      'Unclaimed siblings': String(o.siblings || 0),
      'Submitted': `${rec.submittedAt} from ${rec.ip || ''}`, 'Revision': String(rec.revision || 1),
      'Retailer email sent': viaKlaviyo ? 'by Klaviyo (signup confirmation flow)' : out.retailer && out.retailer.id ? 'yes' : ('NO — ' + JSON.stringify(out.retailer)),
    }, internalClaimExtra(rec, coreListing));
  } catch (e) { out.internal = { error: e.message }; }
  return out;
}

async function sendClaimBulkEmails(src, recs, o = {}) {
  const out = {};
  try {
    out.retailer = await send({ to: [src.contact.email], subject: `Your ${recs.length} other ${src.storeName} ${recs.length === 1 ? 'location is' : 'locations are'} updated on Poof`, html: claimBulkHtml(src, recs, o) });
  } catch (e) { out.retailer = { error: e.message }; }
  try {
    const review = recs.filter(r => r.needsReview && r.needsReview.length);
    const table = `<p style="margin:18px 0 6px;font-weight:700">Locations</p><table style="border-collapse:collapse;font-size:13px">${recs.map(r => `<tr><td style="padding:4px 10px 4px 0;white-space:nowrap">${esc(r.id)}</td><td style="padding:4px 10px 4px 0">${esc(r.location.name)}, ${esc(r.location.city)}</td><td style="padding:4px 10px 4px 0">${esc(r.listing.phone)}</td><td style="padding:4px 10px 4px 0">${esc(hoursLine(r.listing.hours))}</td><td style="padding:4px 0;color:#c00">${esc((r.needsReview || []).join('; '))}</td></tr>`).join('')}</table>
<p style="margin:18px 0 6px;font-weight:700">Core fields (one per store)</p><pre style="background:#f6f6f8;padding:12px;border-radius:8px;font-size:12px;white-space:pre-wrap">${esc(JSON.stringify(recs.map(claims.toCoreListing), null, 2))}</pre>
<p style="font-size:13px;line-height:1.5">Publish each with <code>{"action":"publish","id":"CRSA…"}</code> on /api/claims once it's in HQ.</p>`;
    out.internal = await internalEmail(`Listings claimed in bulk — ${src.storeName} (+${recs.length})${review.length ? ` · ${review.length} to review` : ''}`, {
      'Store': src.storeName, 'Copied from': `${src.id} — ${src.location ? src.location.name : ''} (claimed by ${src.contact.name} · ${src.contact.email})`,
      'Locations': String(recs.length), 'Location IDs': recs.map(r => r.id).join(', '),
      'Poof HQ': recs.map(r => `${r.id} → ${r.hq ? r.hq.url : 'not in core'}`).join(' · '),
      'Needs review': review.length ? review.map(r => r.id).join(', ') : 'none — phone and hours from Google for every store',
      'Logo': src.listing.logoUrl || '', 'Website': src.listing.website || '', 'Instagram': src.listing.instagram ? '@' + src.listing.instagram : '',
      'Description': src.listing.description || '',
      'Submitted': `${recs[0].submittedAt} from ${recs[0].ip || ''}`,
      'Retailer email sent': viaKlaviyo ? 'by Klaviyo (signup confirmation flow)' : out.retailer && out.retailer.id ? 'yes' : ('NO — ' + JSON.stringify(out.retailer)),
    }, table);
  } catch (e) { out.internal = { error: e.message }; }
  return out;
}

/** "Lost your link?" — email 1 again, owner only, no internal copy. */
async function sendClaimLinkEmail(rec, o = {}) {
  try {
    return await send({ to: [rec.contact.email], subject: `Your ${rec.storeName} listing on Poof — your edit link`, html: claimReceivedHtml(rec, o) });
  } catch (e) { return { error: e.message }; }
}

async function sendClaimLiveEmail(rec, liveUrl) {
  return send({ to: [rec.contact.email], subject: `${rec.storeName} is live on Poof — have a look`, html: claimLiveHtml(rec, liveUrl) });
}

module.exports = { sendSignupEmails, internalEmail, sendClaimEmails, sendClaimBulkEmails, sendClaimLinkEmail, sendClaimLiveEmail, claimReceivedHtml, claimLiveHtml, claimBulkHtml };
