// The signup.poof.ca offer (set 2026-11-26). No code needed; the tier depends only on whether a card was added at signup.
//   Card added at signup  → no charge until OFFER_CARD_UNTIL   (June 30, 2027)
//   No card at signup     → no charge until OFFER_NOCARD_UNTIL (March 31, 2027); a card must be on file before then
// Fixed calendar dates, not a count of days from go-live: the campaign launches January 2027.
const config = require('./config');
const { longDate } = require('./promo');

const dayAfter = ymd => new Date(Date.parse(ymd + 'T12:00:00Z') + 864e5).toISOString().slice(0, 10);

function forSignup(hasCard, at) {
  const o = config.SIGNUP_OFFER;
  return hasCard
    ? { code: 'CARD-AT-SIGNUP', tier: 'card', months: 6, until: o.cardUntil, grantedAt: at }
    : { code: 'NO-CARD', tier: 'nocard', months: 3, until: o.noCardUntil, grantedAt: at };
}
const isTier = o => !!(o && o.tier && /^\d{4}-\d{2}-\d{2}$/.test(o.until || ''));

// Plain-language lines for the order form, emails and Notion.
function lines(o) {
  if (!isTier(o)) return null;
  const until = longDate(o.until), starts = longDate(dayAfter(o.until));
  return o.tier === 'card'
    ? { until, headline: `No charge until ${until}`, detail: 'Card added at signup.',
        billingStarts: `${starts}, or the go-live date if that is later. Nothing is charged before then.`,
        short: `Free until ${until} (card on file)` }
    : { until, headline: `No charge until ${until}`, detail: `No card was needed to sign up. A card must be added before ${until} for service to continue after that date.`,
        billingStarts: `${starts}, or the go-live date if that is later, once a card is on file. Nothing is charged before then.`,
        short: `Free until ${until} (no card yet)` };
}

// Unix seconds for the end of the free period (end of that day in Ontario), or null once it has passed.
function trialEnd(o, nowMs = Date.now()) {
  if (!isTier(o)) return null;
  const end = Date.parse(o.until + 'T23:59:59-05:00');
  return Number.isFinite(end) && end > nowMs + 3600e3 ? Math.floor(end / 1000) : null;
}

module.exports = { forSignup, isTier, lines, trialEnd, dayAfter };
