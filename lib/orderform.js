/**
 * orderform.js — the one-page Poof Retail Ad Network order form.
 *
 * This is deliberately NOT a contract. It records the commercial specifics of a
 * single deal — who, where, what systems, how much, which referral code, when
 * billing starts — and incorporates the Poof Dispensary Agreement by reference.
 *
 * Keeping legal language in exactly one document is the whole point. If a term
 * needs to change, it changes in the Agreement; this form only ever changes when
 * the deal changes.
 */

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { POS_OPTIONS, PAYMENT_OPTIONS, DELIVERY_OPTIONS, ECOMMERCE_OPTIONS, labelFor, pendingIntegrations } from './vendors.js';

const MAGENTA = rgb(1.0, 0.239, 0.545);      // #FF3D8B, matching business.poof.ca
const INK = rgb(0.09, 0.08, 0.12);
const MUTED = rgb(0.42, 0.41, 0.48);
const LINE = rgb(0.84, 0.84, 0.88);
const WASH = rgb(0.972, 0.969, 0.98);

const P = { w: 612, h: 792, m: 50 };

export const ORDER_FORM_VERSION = '1.0';

/** Per authorized location, per month, before tax. Mirrors §6.3 of the Agreement. */
export const MONTHLY_FEE_CENTS = 5000;
export const REBATE_MONTHS = 3;

export async function buildOrderForm(submission) {
  const {
    profile = {}, contact = {}, stack = {}, referral = null,
    id, goLiveDate = null, confirmedLocations = []
  } = submission;

  const locations = confirmedLocations.length ? confirmedLocations : (profile.locations || []);
  const count = locations.length || 1;
  const monthly = (count * MONTHLY_FEE_CENTS) / 100;

  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ital = await pdf.embedFont(StandardFonts.HelveticaOblique);

  pdf.setTitle(`Poof Order Form — ${profile.storeName?.value || ''}`);
  pdf.setAuthor('Poof Technologies Inc.');
  pdf.setSubject('Retail Ad Network order form');
  pdf.setCreationDate(new Date());

  const page = pdf.addPage([P.w, P.h]);
  let y = P.h - P.m;

  const text = (s, { size = 9.5, f = font, color = INK, x = P.m } = {}) =>
    page.drawText(String(s), { x, y, size, font: f, color });

  const wrap = (s, { size = 8.5, f = font, color = MUTED, x = P.m, width = P.w - P.m * 2, lead = 3.5 } = {}) => {
    let line = '';
    for (const w of String(s).split(/\s+/)) {
      const test = line ? `${line} ${w}` : w;
      if (f.widthOfTextAtSize(test, size) > width) {
        page.drawText(line, { x, y, size, font: f, color });
        y -= size + lead;
        line = w;
      } else line = test;
    }
    if (line) { page.drawText(line, { x, y, size, font: f, color }); y -= size + lead; }
  };

  const section = title => {
    y -= 8;
    page.drawLine({ start: { x: P.m, y: y + 10 }, end: { x: P.w - P.m, y: y + 10 }, thickness: 0.6, color: LINE });
    page.drawText(title.toUpperCase(), { x: P.m, y, size: 7.5, font: bold, color: MAGENTA });
    y -= 15;
  };

  /** Two-column label/value row. */
  const row = (label, value, { valueFont = font, size = 9.5 } = {}) => {
    if (value === null || value === undefined || value === '') return;
    page.drawText(label, { x: P.m, y, size: 8, font, color: MUTED });
    const lines = [];
    let line = '';
    const maxW = P.w - P.m - 190;
    for (const w of String(value).split(/\s+/)) {
      const t = line ? `${line} ${w}` : w;
      if (valueFont.widthOfTextAtSize(t, size) > maxW) { lines.push(line); line = w; }
      else line = t;
    }
    if (line) lines.push(line);
    lines.forEach((l, i) => {
      page.drawText(l, { x: P.m + 158, y: y - i * 12, size, font: valueFont, color: INK });
    });
    y -= 12 * lines.length + 5;
  };

  /* ── header ─────────────────────────────────────────── */
  page.drawRectangle({ x: 0, y: P.h - 5, width: P.w, height: 5, color: MAGENTA });

  text('POOF TECHNOLOGIES INC.', { size: 8, f: bold, color: MAGENTA });
  y -= 16;
  text('Retail Ad Network — Order Form', { size: 17, f: bold });
  y -= 13;
  text(`Order ${id || '—'} · ${fmtDate(new Date())}`, { size: 8, color: MUTED });
  y -= 18;

  wrap('This Order Form records the commercial terms of a single order and is governed by the Poof '
    + 'Dispensary Agreement, the Terms and Conditions (Schedule "A") and the Payments, Cancellation '
    + 'and Refund Policy (Schedule "B"), each incorporated by reference. The Authorized Locations '
    + 'listed below constitute Schedule "C". Capitalized terms have the meaning given in the Agreement.',
    { size: 8, color: MUTED });

  /* ── parties ────────────────────────────────────────── */
  section('Parties');
  row('Provider', 'Poof Technologies Inc., 100 King Street West, Suite 5600, Toronto, ON M5X 1C9');
  row('Dispensary', profile.storeName?.value || '—', { valueFont: bold });
  row('Authorized contact', [contact.name, contact.email, contact.phone].filter(Boolean).join(' · '));

  /* ── locations ──────────────────────────────────────── */
  section(`Schedule "C" — Authorized Locations (${count})`);
  const shown = locations.slice(0, 6);
  for (const l of shown) {
    page.drawText(`•  ${trunc(l.address || l.name, 76)}`, { x: P.m, y, size: 8.5, font, color: INK });
    if (l.licenceNumber) {
      page.drawText(l.licenceNumber, { x: P.w - P.m - 92, y, size: 8, font, color: MUTED });
    }
    y -= 12;
  }
  if (locations.length > shown.length) {
    page.drawText(`+ ${locations.length - shown.length} further Locations listed in Schedule "C" to the Agreement`,
      { x: P.m, y, size: 8, font: ital, color: MUTED });
    y -= 12;
  }
  y -= 3;

  /* ── systems ────────────────────────────────────────── */
  section('Systems');
  row('Point of sale', labelFor(POS_OPTIONS, stack.pos, stack.posOther) || '—');
  row('Payment processor', labelFor(PAYMENT_OPTIONS, stack.payment, stack.paymentOther) || '—');
  row('E-commerce', labelFor(ECOMMERCE_OPTIONS, stack.ecommerce, stack.ecommerceOther) || '—');
  row('Delivery', stack.delivers
    ? `Yes — ${labelFor(DELIVERY_OPTIONS, stack.deliverySoftware, stack.deliveryOther) || 'to be confirmed'}`
    : stack.wantsDelivery ? 'Not currently — interested in offering it' : 'No');

  const pending = pendingIntegrations(stack);
  if (pending.length) {
    wrap(`To connect during setup: ${pending.map(p => p.vendor).join(', ')}. Credentials are supplied `
      + 'through the authenticated Poof admin panel, never by email or chat.', { size: 7.5 });
  }

  /* ── fees ───────────────────────────────────────────── */
  section('Fees');

  const boxTop = y + 6;
  const boxH = referral ? 76 : 60;
  page.drawRectangle({
    x: P.m - 8, y: boxTop - boxH, width: P.w - P.m * 2 + 16, height: boxH,
    color: WASH, borderColor: LINE, borderWidth: 0.6
  });
  y -= 4;

  row('Retail Ad Network', `CAD $50.00 per Authorized Location per month`, { valueFont: bold });
  row('Locations', `${count} × $50.00`);
  row('Monthly subtotal', `CAD $${monthly.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}, plus applicable taxes`, { valueFont: bold });
  if (referral) {
    row('Referral rebate', `${referral.monthsCredited || REBATE_MONTHS} months at no charge`
      + (referral.code ? ` — code ${referral.code}` : '')
      + (referral.brand ? ` (${referral.brand})` : ''));
  }
  y -= 8;

  /* ── billing start ──────────────────────────────────── */
  section('Billing Start Date');
  if (goLiveDate) {
    row('Billing starts', fmtDate(new Date(goLiveDate)), { valueFont: bold });
  } else {
    page.drawText('To be confirmed in writing by Poof', { x: P.m + 158, y, size: 9.5, font: ital, color: MUTED });
    page.drawLine({ start: { x: P.m + 158, y: y - 4 }, end: { x: P.m + 330, y: y - 4 }, thickness: 0.6, color: LINE });
    page.drawText('Billing starts', { x: P.m, y, size: 8, font, color: MUTED });
    y -= 17;
  }
  wrap('No amount is charged on signature. A payment method is stored with Stripe; Poof does not receive '
    + 'or store card numbers. Billing commences only on the Billing Start Date, being the date the '
    + 'Dispensary confirms participation with an authorized Poof representative, as provided in §6.5 of '
    + 'the Agreement.', { size: 7.5 });

  /* ── acceptance ─────────────────────────────────────── */
  const acc = submission.acceptance;
  y -= 14;
  page.drawLine({ start: { x: P.m, y: y + 8 }, end: { x: P.w - P.m, y: y + 8 }, thickness: 0.6, color: LINE });
  y -= 6;
  section('Acceptance');

  if (acc) {
    row('Accepted by', `${acc.acceptedBy}${acc.acceptedTitle ? `, ${acc.acceptedTitle}` : ''}`, { valueFont: bold });
    row('E-mail', acc.acceptedEmail);
    row('Accepted at', new Date(acc.acceptedAt).toLocaleString('en-CA', { timeZone: 'America/Toronto' }) + ' (Toronto)');
    row('Terms version', `${acc.termsVersion}${acc.termsHash ? ` · ${String(acc.termsHash).slice(0, 16)}` : ''}`);
    if (acc.ip) row('IP address', acc.ip);
    row('Locations covered', `${acc.locationCount} — all Authorized Locations listed above`);
    y -= 2;
    wrap('Accepted electronically through the Poof registration flow by selecting a box indicating '
      + 'acceptance, and confirmed as authorised to bind the Dispensary. This constitutes execution '
      + 'of the Poof Dispensary Agreement and Schedule "C" under the Electronic Commerce Act, 2000 '
      + '(Ontario).', { size: 7.5 });
  } else {
    y -= 6;
    for (const [x, w, label] of [[P.m, 200, 'Signature'], [P.m + 226, 130, 'Name and title'], [P.m + 376, 110, 'Date']]) {
      page.drawLine({ start: { x, y }, end: { x: x + w, y }, thickness: 0.7, color: LINE });
      page.drawText(label, { x, y: y - 10, size: 7.5, font, color: MUTED });
    }
    y -= 22;
  }

  /* ── footer ─────────────────────────────────────────── */
  page.drawText(`Poof Technologies Inc. · Order Form v${ORDER_FORM_VERSION} · ${id || ''}`,
    { x: P.m, y: 28, size: 7, font, color: MUTED });
  page.drawText('Governed by the Poof Dispensary Agreement',
    { x: P.w - P.m - 172, y: 28, size: 7, font, color: MUTED });

  return Buffer.from(await pdf.save());
}

const trunc = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));
const fmtDate = d => d.toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric' });
