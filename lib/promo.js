// Promo / discount codes. One place for normalising what a retailer types, describing a coupon,
// and "locking" a discount onto the signup record so it survives the code being switched off later.
//
// Why lock: the discount is applied at go-live (api/activate.js), which can be weeks after signup.
// A webinar code that is deactivated after the event would otherwise silently fall back to the
// launch offer. The lock stores the coupon id; activation applies the coupon directly when the
// promotion code is no longer active.

// "poof 180", "POOF-180 " → "POOF180" / "POOF-180". Whitespace is never part of a Stripe code.
const normCode = (s) => String(s == null ? '' : s).replace(/\s+/g, '').toUpperCase().slice(0, 32);

// Whole free months, when the coupon is 100% off for a fixed number of months. Otherwise null.
const freeMonths = (c) => (c && c.percent_off === 100 && c.duration === 'repeating' && c.duration_in_months > 0 ? c.duration_in_months : null);

// A fixed free period set on the coupon's metadata: free_days (e.g. 180) and, optionally, free_until
// (YYYY-MM-DD, last free day in Ontario). When present it replaces the coupon's own discount: the store
// gets `free_days` from go-live, and never past `free_until`. Applied as a trial at activation.
function freeTerms(c) {
  const md = (c && c.metadata) || {};
  const days = parseInt(md.free_days, 10);
  if (!(days > 0)) return null;
  const until = /^\d{4}-\d{2}-\d{2}$/.test(md.free_until || '') ? md.free_until : null;
  return { days, until };
}

// Unix seconds when the free period ends for a store going live at `nowMs`, or null if the window has closed.
function trialEnd(terms, nowMs = Date.now()) {
  if (!terms || !(terms.days > 0)) return null;
  let end = nowMs + terms.days * 86400e3;
  if (terms.until) {
    // End of that day in Toronto. Noon UTC of the following day is always past local midnight, summer or winter,
    // so take local midnight from the date itself: 04:00Z (EDT) is the earliest it can be; use the later 05:00Z (EST).
    const cap = Date.parse(terms.until + 'T23:59:59-05:00');
    if (Number.isFinite(cap)) end = Math.min(end, cap);
  }
  return end > nowMs + 3600e3 ? Math.floor(end / 1000) : null;
}

const longDate = (ymd) => new Date(ymd + 'T12:00:00Z').toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });

function describe(c) {
  if (!c) return '';
  const t = freeTerms(c);
  if (t) return `${t.days} days free`;
  const m = freeMonths(c);
  if (m) return `${m} ${m === 1 ? 'month' : 'months'} free`;
  if (c.percent_off) return `${c.percent_off}% off${c.duration === 'repeating' ? ` for ${c.duration_in_months} months` : c.duration === 'forever' ? ', ongoing' : ''}`;
  if (c.amount_off) return `$${(c.amount_off / 100).toFixed(2)} off`;
  return c.name || '';
}

// Active promotion code by its customer-facing code, or null.
async function findActive(stripe, code) {
  const c = normCode(code);
  if (!c) return null;
  const list = await stripe.promotionCodes.list({ code: c, active: true, limit: 1 });
  return list.data[0] || null;
}

// What gets stored on the signup record.
function lock(p) {
  const c = p.coupon || {};
  const t = freeTerms(c);
  return { code: p.code, promoId: p.id, couponId: c.id || null, months: t ? null : freeMonths(c), days: t ? t.days : null, until: t ? t.until : null, description: describe(c), lockedAt: new Date().toISOString() };
}

// "POOF180 — 6 months free" for dashboards, emails and the order form.
const label = (r) => (r && r.code ? `${r.code}${r.description ? ` — ${r.description}` : ''}` : '');

module.exports = { normCode, freeMonths, freeTerms, trialEnd, longDate, describe, findActive, lock, label };
