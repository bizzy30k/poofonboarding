// Email. The retailer gets their order form (PDF attached) and baz@poof.ca is
// copied. Sends through SendGrid if SENDGRID_API_KEY is set, else Resend if
// RESEND_API_KEY is set. Web3Forms is the internal-notification fallback so a
// signup never goes unnoticed even if neither is configured yet.
const config = require('./config');
const sec = require('./security');

function parseFrom(from) { const m = String(from).match(/^\s*(.*?)\s*<([^>]+)>\s*$/); return m ? { name: m[1].replace(/^"|"$/g, ''), email: m[2] } : { email: String(from).trim() }; }

async function sendgrid({ to, cc, subject, html, attachments }) {
  const r = await sec.fetchT('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.SENDGRID_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: to.map(email => ({ email })), ...(cc && cc.length ? { cc: cc.map(email => ({ email })) } : {}) }],
      from: parseFrom(config.FROM_EMAIL),
      reply_to: { email: config.REPLY_TO || parseFrom(config.FROM_EMAIL).email },
      subject,
      content: [{ type: 'text/html', value: html }],
      attachments: (attachments || []).map(a => ({ filename: a.filename, content: a.content, type: 'application/pdf', disposition: 'attachment' })),
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

async function web3forms(fields) {
  if (!config.WEB3FORMS_KEY) return { skipped: 'no WEB3FORMS_KEY' };
  const r = await sec.fetchT('https://api.web3forms.com/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ access_key: config.WEB3FORMS_KEY, ...fields }),
  });
  return r.json().catch(() => ({}));
}

function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function retailerHtml(record, orderFormUrl) {
  const n = record.locations.length;
  const a = record.acceptance;
  const rows = [
    ['Store', record.store.chainName],
    ['Locations', `${n} — ${record.locations.map(l => l.city).filter((c, i, arr) => arr.indexOf(c) === i).slice(0, 6).join(', ')}${n > 6 ? '…' : ''}`],
    ['Monthly', `${n} × $${config.PRICE_CAD} = $${n * config.PRICE_CAD}/mo + HST — nothing charged until go-live`],
    ['Point of sale', record.systems.pos],
    ['Payment processor', record.systems.processor],
    ['Agreement', `Accepted by ${a.name}${a.title ? ', ' + a.title : ''} · version ${a.termsVersion}`],
    record.offer ? ['Launch offer', `${record.offer.months} months free, applied at go-live`] : null,
    record.cardSkipped ? ['Card', 'Not added yet — we\'ll take it on the setup call'] : null,
  ].filter(Boolean);
  return `<!doctype html><body style="font-family:Helvetica,Arial,sans-serif;color:#08080a;max-width:560px;margin:0 auto;padding:24px">
  <p style="font-size:22px;font-weight:700;margin:0 0 18px">poof<span style="color:#ff3d8b">.</span></p>
  <p style="font-size:16px;margin:0 0 14px">You're in, ${esc(record.owner.name.split(' ')[0])}.</p>
  <p style="margin:0 0 18px;line-height:1.5">Your order form is attached. It lists every location you added and the agreement you accepted. Keep it for your records — nothing is charged until you approve your menu and go live.</p>
  <table style="border-collapse:collapse;width:100%;font-size:14px">${rows.map(([k, v]) => `<tr><td style="padding:7px 0;color:#777;width:150px;vertical-align:top">${esc(k)}</td><td style="padding:7px 0">${esc(v)}</td></tr>`).join('')}</table>
  <p style="margin:18px 0;line-height:1.5"><b>What happens next</b><br>1. Our team reaches out within one business day.<br>2. We contact your POS and payment providers, with you copied.<br>3. Your admin login arrives with your menu configured.<br>4. You approve, we go live, and billing starts then.</p>
  <p style="margin:0 0 18px"><a href="${orderFormUrl}" style="color:#ff3d8b">Download your order form</a> · <a href="${config.TERMS_URL}" style="color:#ff3d8b">Agreement and schedules</a></p>
  <p style="font-size:12px;color:#999;line-height:1.5">${esc(config.COMPANY)} · ${esc(config.COMPANY_ADDR)}<br>Questions: reply to this e-mail or write to contact@poof.ca.</p></body>`;
}

async function sendSignupEmails(record, pdfBuffer, orderFormUrl) {
  const out = {};
  const n = record.locations.length;
  const subject = `Poof — your order form for ${record.store.chainName} (${n} ${n === 1 ? 'location' : 'locations'})`;

  // 1. Retailer copy with PDF, internal cc
  try {
    out.retailer = await send({
      to: [record.owner.email],
      cc: [config.INTERNAL_EMAIL],
      subject,
      html: retailerHtml(record, orderFormUrl),
      attachments: [{ filename: `Poof-Order-Form-${record.store.chainName.replace(/[^a-z0-9]+/gi, '-')}.pdf`, content: pdfBuffer.toString('base64') }],
    });
  } catch (e) { out.retailer = { error: e.message }; }

  // 2. Internal notification (always, as a safety net)
  try {
    out.internal = await web3forms({
      subject: `New retailer signup — ${record.store.chainName} (${n})`,
      from_name: 'onboarding.poof.ca',
      'Store': record.store.chainName,
      'Locations': String(n),
      'Location IDs': record.locations.map(l => l.id).join(', '),
      'Groups': (record.groups || []).map(g => `${g.name} (${g.ids.length})`).join('; ') || 'none',
      'Contact': `${record.owner.name} · ${record.owner.email} · ${record.owner.mobile || ''}`,
      'POS': record.systems.pos, 'Processor': record.systems.processor,
      'E-commerce': record.systems.ecommerce || 'none',
      'Delivery': record.systems.delivery ? (record.systems.deliverySoftware || 'yes') : 'no',
      'Referral code': record.referral?.code || 'none',
      'Accepted by': `${record.acceptance.name}, ${record.acceptance.title} at ${record.acceptance.at} from ${record.acceptance.ip}`,
      'Terms version': record.acceptance.termsVersion,
      'Card on file': record.cardSkipped ? 'NO — collect on setup call' : 'yes',
      'Launch offer': record.offer ? record.offer.code : 'none',
      'Entry store': record.entryStoreId || '',
      'FRANCHISE CONFLICT': (record.conflicts || []).length ? record.conflicts.map(c => `${c.overlap.length} door(s) also on ${c.customerId} (${c.email}, ${c.stage})`).join('; ') : 'none',
      'Stripe customer': record.customerId,
      'Setup intent': record.setupIntent,
      'Order form': orderFormUrl,
      'Retailer email sent': out.retailer && out.retailer.id ? 'yes' : ('NO — ' + JSON.stringify(out.retailer)),
    });
  } catch (e) { out.internal = { error: e.message }; }
  return out;
}

module.exports = { sendSignupEmails };
