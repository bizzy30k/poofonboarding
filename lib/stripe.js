// One Stripe client factory so every handler gets the same timeout/retry policy.
// Stripe's default 80 s timeout is longer than the 30 s lambda — a stalled call would
// kill the function with no error path.
const Stripe = require('stripe');
const config = require('./config');
let client = null;
function stripeClient() {
  if (!config.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY not set');
  if (!client) client = new Stripe(config.STRIPE_SECRET_KEY, { timeout: 8000, maxNetworkRetries: 1 });
  return client;
}
module.exports = { stripeClient };
