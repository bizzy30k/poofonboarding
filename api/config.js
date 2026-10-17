// GET /api/config → public config the page needs. Keeps keys out of index.html.
const config = require('../lib/config');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=60');
  return res.status(200).json({
    stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
    termsUrl: config.TERMS_URL,
    termsVersion: config.TERMS_VERSION,
    priceCad: config.PRICE_CAD,
    offer: config.offerActive() ? { months: config.LAUNCH_OFFER.months, until: config.LAUNCH_OFFER.until, label: config.LAUNCH_OFFER.label } : null,
    calendly: config.CALENDLY_URL,
    sms: config.SMS_NUMBER,
    testimonial: config.TESTIMONIAL.quote ? config.TESTIMONIAL : null,
    brands: config.BRANDS,
    retailerCount: config.RETAILER_COUNT,
    ga4: config.GA4_ID,
    mapKey: process.env.MAPTILER_KEY || '',
    placesEnabled: !!config.GOOGLE_PLACES_KEY,
    ready: !!(config.STRIPE_SECRET_KEY && process.env.STRIPE_PUBLISHABLE_KEY),
  });
};
