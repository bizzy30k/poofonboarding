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

function describe(c) {
  if (!c) return '';
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
  return { code: p.code, promoId: p.id, couponId: c.id || null, months: freeMonths(c), description: describe(c), lockedAt: new Date().toISOString() };
}

// "POOF180 — 6 months free" for dashboards, emails and the order form.
const label = (r) => (r && r.code ? `${r.code}${r.description ? ` — ${r.description}` : ''}` : '');

module.exports = { normCode, freeMonths, describe, findActive, lock, label };
