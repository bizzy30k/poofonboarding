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
  SMS_NUMBER: env('SMS_NUMBER', ''),              // e.g. +14165550100 — shows a "Text Baz" button when set

  // Social proof at the pricing beat. Fill TESTIMONIAL to show the quote card.
  TESTIMONIAL: { quote: env('TESTIMONIAL_QUOTE', ''), name: env('TESTIMONIAL_NAME', 'Mo'), store: env('TESTIMONIAL_STORE', 'The We Store') },
  BRANDS: ['Ufeelu', 'Hi Feel U', 'Lune Rise Farms', 'Highxotic', 'Strains Limited', 'Dom Jackson'],
  RETAILER_COUNT: env('RETAILER_COUNT', ''),      // e.g. "80+" — leave blank to hide the claim

  GA4_ID: env('GA4_ID', 'G-DDVX27NB26'),

  FROM_EMAIL: env('FROM_EMAIL', 'Poof <baz@poof.ca>'),
  INTERNAL_EMAIL: env('INTERNAL_EMAIL', 'baz@poof.ca'),
  ONBOARDING_INBOX: env('ONBOARDING_INBOX', 'onboarding@poof.ca'),

  // ---- Secrets (Vercel → Settings → Environment Variables) ----
  STRIPE_SECRET_KEY: env('STRIPE_SECRET_KEY'),
  RESEND_API_KEY: env('RESEND_API_KEY'),           // optional — retailer email + PDF attachment
  WEB3FORMS_KEY: env('WEB3FORMS_KEY'),             // optional — internal notification fallback
  GOOGLE_PLACES_KEY: env('GOOGLE_PLACES_KEY'),     // optional — rating / hours / phone
  KLAVIYO_API_KEY: env('KLAVIYO_API_KEY'),         // optional — "Onboarding Started/Completed" events for abandonment flows
  ADMIN_KEY: env('ADMIN_KEY'),                     // required for /api/activate and /api/links

  signingSecret() {
    return env('SIGNING_SECRET') || crypto.createHash('sha256').update(String(this.STRIPE_SECRET_KEY || 'dev')).digest('hex');
  },
  sign(value) {
    return crypto.createHmac('sha256', this.signingSecret()).update(String(value)).digest('hex').slice(0, 32);
  },
  // Resume tokens carry the whole in-progress state, signed, so no storage is needed.
  encodeResume(state) {
    const body = Buffer.from(JSON.stringify(state)).toString('base64url');
    return body + '.' + this.sign(body).slice(0, 16);
  },
  decodeResume(token) {
    const [body, sig] = String(token || '').split('.');
    if (!body || !sig || this.sign(body).slice(0, 16) !== sig) return null;
    try { return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch (e) { return null; }
  },
};
