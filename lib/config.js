// Central config. Everything here is either public or read from env.
const crypto = require('crypto');

const env = (k, d) => (process.env[k] && process.env[k].trim()) || d;

module.exports = {
  // ---- Public ----
  TERMS_URL: 'https://business.poof.ca/terms',
  TERMS_VERSION: '2026-08-15',
  PRICE_CAD: 50,
  PRICE_ID: env('STRIPE_PRICE_ID', 'price_1U4PwmPLaXlBkTYFxqt7V0HT'),
  COMPANY: 'Poof Technologies Inc.',
  COMPANY_ADDR: '5600-100 King St. W., Toronto, ON M5X 1C9',
  SITE_URL: env('SITE_URL', 'https://onboarding.poof.ca'),

  // Launch offer: 3 months free when the retailer adds a card during signup.
  // Applied at go-live. Create a Stripe promotion code with this exact code
  // (coupon mKwuq2u8, 100% off × 3 months) before launch.
  LAUNCH_OFFER: {
    code: env('LAUNCH_OFFER_CODE', 'LAUNCH3'),
    months: 3,
    until: env('LAUNCH_OFFER_UNTIL', '2026-12-31'),   // last day, inclusive, America/Toronto
    label: '3 months free',
  },
  offerActive() {
    const until = new Date(this.LAUNCH_OFFER.until + 'T23:59:59-05:00');
    return Date.now() <= until.getTime();
  },

  // Exits for hesitant visitors
  CALENDLY_URL: env('CALENDLY_URL', 'https://calendly.com/baz-poof/30min'),
  SMS_NUMBER: env('SMS_NUMBER', ''),              // e.g. +14165550100 — shows a "Text us" button when set

  // Social proof at the pricing beat. Fill TESTIMONIAL to show the quote card.
  TESTIMONIAL: { quote: env('TESTIMONIAL_QUOTE', ''), name: env('TESTIMONIAL_NAME', 'Mo'), store: env('TESTIMONIAL_STORE', 'The We Store') },
  BRANDS: ['Ufeelu', 'Hi Feel U', 'Lune Rise Farms', 'Highxotic', 'Strains Limited'],
  RETAILER_COUNT: env('RETAILER_COUNT', ''),      // e.g. "80+" — leave blank to hide the claim

  GA4_ID: env('GA4_ID', 'G-DDVX27NB26'),

  FROM_EMAIL: env('FROM_EMAIL', 'Poof <baz@poof.ca>'),
  INTERNAL_EMAIL: env('INTERNAL_EMAIL', 'baz@poof.ca'),
  ONBOARDING_INBOX: env('ONBOARDING_INBOX', 'onboarding@poof.ca'),

  // ---- Secrets (Vercel → Settings → Environment Variables) ----
  STRIPE_SECRET_KEY: env('STRIPE_SECRET_KEY'),
  SENDGRID_API_KEY: env('SENDGRID_API_KEY'),       // retailer email + PDF attachment (preferred — poof.ca already authenticated there)
  RESEND_API_KEY: env('RESEND_API_KEY'),           // alternative to SendGrid
  REPLY_TO: env('REPLY_TO', 'contact@poof.ca'),
  GOOGLE_PLACES_KEY: env('GOOGLE_PLACES_KEY'),     // optional — rating / hours / phone
  KLAVIYO_API_KEY: env('KLAVIYO_API_KEY'),         // optional — "Onboarding Started/Completed" events for abandonment flows
  ADMIN_KEY: env('ADMIN_KEY'),                     // required for /api/activate, /api/links, /api/core-export
  CORE_WEBHOOK_URL: env('CORE_WEBHOOK_URL'),       // optional — Poof HQ core endpoint that receives signups (lib/core.js)
  CORE_WEBHOOK_SECRET: env('CORE_WEBHOOK_SECRET'), // required if CORE_WEBHOOK_URL is set — HMAC secret shared with core
  SIGNING_SECRET: env('SIGNING_SECRET'),
  TURNSTILE_SITE_KEY: env('TURNSTILE_SITE_KEY'),     // Cloudflare Turnstile (public) — bot check on the email step
  TURNSTILE_SECRET_KEY: env('TURNSTILE_SECRET_KEY'), // Cloudflare Turnstile (private) — server-side verify           // required in production (≥32 chars) — see signingSecret()

  // Signing key for resume links, order-form links and session tokens.
  // Must be set explicitly in production — never derived from another secret, so
  // rotating the Stripe key can't silently invalidate every link already emailed.
  signingSecret() {
    const s = env('SIGNING_SECRET');
    if (s && s.length >= 32) return s;
    if (process.env.VERCEL_ENV === 'production') throw new Error('SIGNING_SECRET is not set (min 32 chars). Refusing to sign anything.');
    return 'dev-only-signing-secret-not-for-production';
  },
  sign(value, purpose = 'link') {
    return crypto.createHmac('sha256', this.signingSecret()).update(`${purpose}:${value}`).digest('hex');
  },
  verify(value, sig, purpose = 'link') {
    const a = Buffer.from(this.sign(value, purpose)); const b = Buffer.from(String(sig || ''));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  },
  // Order-form links: signed over customer id + expiry (default 90 days).
  orderFormToken(customerId, days = 90) {
    const exp = Date.now() + days * 86400e3;
    return `${exp}.${this.sign(`${customerId}:${exp}`, 'orderform')}`;
  },
  checkOrderFormToken(customerId, token) {
    const [exp, sig] = String(token || '').split('.');
    if (!/^\d+$/.test(exp || '') || Number(exp) < Date.now()) return false;
    return this.verify(`${customerId}:${exp}`, sig, 'orderform');
  },
  // Resume tokens carry the whole in-progress state, signed, so no storage is needed.
  encodeResume(state) {
    const body = Buffer.from(JSON.stringify(state)).toString('base64url');
    return body + '.' + this.sign(body, 'resume');
  },
  decodeResume(token) {
    const [body, sig] = String(token || '').split('.');
    if (!body || !sig || !this.verify(body, sig, 'resume')) return null;
    try { return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch (e) { return null; }
  },
};
