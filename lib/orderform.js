// Order Form PDF — Schedule "C" (Authorized Locations) + execution record.
// Generated on acceptance, emailed to the retailer, downloadable from the
// success screen, and regenerable at any time from the Stripe customer record.
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

// Helvetica (WinAnsi) can't encode every character; strip accents and drop the rest
// so a name like "Nguyễn" or an emoji in a store name can't crash the order form.
function safe(s) { return String(s == null ? '' : s).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7E\xA0-\xFF]/g, '?'); }
const config = require('./config');

const PINK = rgb(1, 0.24, 0.545);
const INK = rgb(0.03, 0.03, 0.04);
const MUTED = rgb(0.45, 0.45, 0.5);
const LINE = rgb(0.85, 0.85, 0.88);

function fmtDate(iso) {
  try { return new Date(iso).toLocaleString('en-CA', { timeZone: 'America/Toronto', dateStyle: 'long', timeStyle: 'short' }) + ' (Toronto)'; }
  catch (e) { return iso; }
}

async function buildOrderForm(record, opts = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const P = { w: 612, h: 792, m: 48 };
  let page = doc.addPage([P.w, P.h]);
  let y = P.h - P.m;

  const locs = record.locations || [];
  const n = locs.length;
  const monthly = n * config.PRICE_CAD;
  const a = record.acceptance || {};
  const sys = record.systems || {};
  const owner = record.owner || {};
  const orderNo = (record.customerId || 'cus_').replace('cus_', 'PO-').slice(0, 18).toUpperCase();

  function newPage() { page = doc.addPage([P.w, P.h]); y = P.h - P.m; }
  function ensure(h) { if (y - h < P.m + 30) newPage(); }
  function text(s, x, size = 10, f = font, color = INK) { page.drawText(safe(s), { x, y, size, font: f, color }); }
  function line() { page.drawLine({ start: { x: P.m, y }, end: { x: P.w - P.m, y }, thickness: 0.6, color: LINE }); }
  function wrap(s, size = 9.5, color = INK, f = font, maxW = P.w - 2 * P.m) {
    const words = String(s).split(/\s+/); let cur = '';
    const lines = [];
    for (const w of words) {
      const t = cur ? cur + ' ' + w : w;
      if (f.widthOfTextAtSize(t, size) > maxW) { lines.push(cur); cur = w; } else cur = t;
    }
    if (cur) lines.push(cur);
    for (const l of lines) { ensure(size + 4); text(l, P.m, size, f, color); y -= size + 4; }
  }
  function splitLines(s, f, size, maxW) {
    const lines = []; let cur = '';
    for (const w of safe(s).split(/\s+/)) { const t = cur ? cur + ' ' + w : w; if (f.widthOfTextAtSize(t, size) > maxW && cur) { lines.push(cur); cur = w; } else cur = t; }
    if (cur) lines.push(cur);
    return lines;
  }
  function row(label, value, valueFont = font) {
    const lines = splitLines(value || '—', valueFont, 10, P.w - 2 * P.m - 150);
    ensure(14 * lines.length + 4);
    text(label.toUpperCase(), P.m, 7.5, bold, MUTED);
    for (const l of lines) { page.drawText(safe(l), { x: P.m + 150, y, size: 10, font: valueFont, color: INK }); y -= 14; }
    y -= 3;
  }
  function section(title) {
    ensure(34);
    y -= 10;
    text(title.toUpperCase(), P.m, 8.5, bold, PINK);
    y -= 6; line(); y -= 14;
  }

  // Header
  text('poof.', P.m, 22, bold, INK);
  text('ORDER FORM', P.w - P.m - bold.widthOfTextAtSize('ORDER FORM', 11), 11, bold, MUTED);
  y -= 16;
  text(config.COMPANY + ' · ' + config.COMPANY_ADDR, P.m, 8, font, MUTED);
  text('No. ' + orderNo, P.w - P.m - font.widthOfTextAtSize('No. ' + orderNo, 8), 8, font, MUTED);
  y -= 22;
  wrap('This Order Form records the commercial terms of a single order and is governed by the Poof Dispensary Agreement, the Terms and Conditions (Schedule "A") and the Payments, Cancellation and Refund Policy (Schedule "B"), each incorporated by reference and published at ' + config.TERMS_URL + ' (version ' + config.TERMS_VERSION + '). The Authorized Locations listed below constitute Schedule "C". Capitalized terms have the meaning given in the Agreement.', 8.5, MUTED);

  section('Dispensary');
  row('Operating name', record.store?.chainName, bold);
  row('Account owner', owner.name);
  row('E-mail', owner.email);
  if (owner.mobile) row('Mobile', owner.mobile);
  row('AGCO status', 'Authorized to Open — ' + n + (n === 1 ? ' licence' : ' licences') + ' on file');

  section('Services and fees');
  row('Service', 'Retail Ad Network — POS integration, live menu on the Poof marketplace, brand-funded campaign routing');
  row('Fee', `CAD $${config.PRICE_CAD.toFixed(2)} per Authorized Location per month, plus HST`);
  row('Locations', `${n} × $${config.PRICE_CAD.toFixed(2)} = $${monthly.toFixed(2)} per month + HST`, bold);
  row('Billing starts', 'On the go-live date, after the Dispensary approves its configured menu. Nothing is charged before then.');
  row('Term', 'Month to month. Cancel any time per Schedule "B".');
  if (record.referral?.code) row('Referral code', `${record.referral.code} — applied at activation (first 90 days at no charge where valid)`);
  else if (record.offer) row('Launch offer', `${record.offer.months} months at no charge, applied at activation (card added during signup)`);

  section('Systems');
  row('Point of sale', sys.pos);
  row('Payment processor', sys.processor);
  row('E-commerce', sys.ecommerce || 'None');
  row('Delivery', sys.delivery ? ('Yes — ' + (sys.deliverySoftware || 'software not specified')) : 'No');
  wrap('The Dispensary authorises Poof to contact the providers above (Integration Partner Authorization, Schedule "A" §5) to establish the connection, with the Dispensary copied on every message.', 8.5, MUTED);

  section(`Schedule "C" — Authorized Locations (${n})`);
  const groups = record.groups || [];
  const grouped = new Set(groups.flatMap(g => g.ids));
  function locRow(l, i) {
    ensure(26);
    text(String(i + 1).padStart(2, '0'), P.m, 9, bold, MUTED);
    text(l.name, P.m + 22, 9.5, bold);
    text(l.id, P.w - P.m - font.widthOfTextAtSize(l.id, 8), 8, font, MUTED);
    y -= 12;
    text(`${l.addr}, ${l.city}, ON ${l.postal}`, P.m + 22, 8.5, font, MUTED);
    y -= 14;
  }
  let i = 0;
  for (const g of groups) {
    ensure(50);
    text(`${g.name} · ${g.ids.length} ${g.ids.length === 1 ? 'store' : 'stores'}`, P.m, 9, bold, PINK);
    y -= 14;
    for (const id of g.ids) { const l = locs.find(x => x.id === id); if (l) locRow(l, i++); }
    y -= 4;
  }
  const rest = locs.filter(l => !grouped.has(l.id));
  if (groups.length && rest.length) { ensure(50); text('Ungrouped', P.m, 9, bold, PINK); y -= 14; }
  for (const l of rest) locRow(l, i++);

  section('Execution');
  if (a.at) {
    row('Accepted by', `${a.name}${a.title ? ', ' + a.title : ''}`, bold);
    row('E-mail', a.email);
    row('Accepted at', fmtDate(a.at));
    row('Terms version', `${a.termsVersion}${a.termsHash ? ' · ' + String(a.termsHash).slice(0, 16) : ''}`);
    if (a.ip) row('IP address', a.ip);
    row('Locations covered', `${n} — all Authorized Locations listed above`);
    row('Card on file', record.setupIntent ? 'Yes — Stripe, nothing charged until go-live' : 'No — to be collected on the setup call');
    if (record.entryStoreId) row('Signed up from', record.entryStoreId + ' (entry location)');
    y -= 2;
    wrap('Accepted electronically through the Poof registration flow by selecting a box indicating acceptance, and confirmed as authorised to bind the Dispensary. This constitutes execution of the Poof Dispensary Agreement and Schedule "C" under the Electronic Commerce Act, 2000 (Ontario).', 7.5, MUTED);
  } else {
    y -= 6;
    for (const [x, w, label] of [[P.m, 200, 'Signature'], [P.m + 226, 130, 'Name and title'], [P.m + 376, 110, 'Date']]) {
      page.drawLine({ start: { x, y }, end: { x: x + w, y }, thickness: 0.7, color: LINE });
      page.drawText(label, { x, y: y - 10, size: 7.5, font, color: MUTED });
    }
    y -= 22;
  }

  // Footer on every page
  const pages = doc.getPages();
  pages.forEach((pg, idx) => {
    pg.drawText(`${config.COMPANY} · Order Form ${orderNo} · Page ${idx + 1} of ${pages.length}`, { x: P.m, y: 28, size: 7, font, color: MUTED });
  });

  doc.setTitle(`Poof Order Form ${orderNo}`);
  doc.setAuthor(config.COMPANY);
  return Buffer.from(await doc.save());
}

module.exports = { buildOrderForm };
