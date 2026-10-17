// GET /api/promo?code=BUZZD → { valid, code, description }
// Validates a referral / promo code against Stripe so the flow never accepts
// a code that won't apply at activation.
const Stripe = require('stripe');
const config = require('../lib/config');

module.exports = async (req, res) => {
  const code = String((req.query || {}).code || '').trim().toUpperCase();
  if (!code || code.length > 32) return res.status(400).json({ valid: false });
  try {
    const stripe = new Stripe(config.STRIPE_SECRET_KEY);
    const list = await stripe.promotionCodes.list({ code, active: true, limit: 1 });
    const p = list.data[0];
    if (!p) return res.status(200).json({ valid: false, code });
    const c = p.coupon;
    const desc = c.percent_off ? `${c.percent_off}% off${c.duration === 'repeating' ? ` for ${c.duration_in_months} months` : c.duration === 'forever' ? ', ongoing' : ''}`
      : c.amount_off ? `$${(c.amount_off / 100).toFixed(2)} off` : c.name;
    return res.status(200).json({ valid: true, code: p.code, description: desc, promotionCodeId: p.id });
  } catch (e) {
    return res.status(200).json({ valid: false, code, error: 'Could not check the code right now.' });
  }
};
