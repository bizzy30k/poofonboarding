// GET /api/promo?code=BUZZD → { valid, code, description, months }
// Validates a referral / discount code against Stripe so the flow never accepts
// a code that won't apply at activation. Spaces are ignored ("POOF 180" = "POOF180").
const { stripeClient } = require('../lib/stripe');
const sec = require('../lib/security');
const promo = require('../lib/promo');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ valid: false });
  if (!sec.rateLimit(`promo:${sec.clientIp(req)}`, 10, 60e3)) return sec.tooMany(res);
  const raw = String((req.query || {}).code || '');
  const code = promo.normCode(raw);
  if (!code || raw.trim().length > 40) return res.status(400).json({ valid: false });
  try {
    const p = await promo.findActive(stripeClient(), code);
    if (!p) return res.status(200).json({ valid: false, code });
    const t = promo.freeTerms(p.coupon);
    return res.status(200).json({ valid: true, code: p.code, description: promo.describe(p.coupon), months: t ? null : promo.freeMonths(p.coupon), days: t ? t.days : null, until: t ? t.until : null, promotionCodeId: p.id });
  } catch (e) {
    return res.status(200).json({ valid: false, code, error: 'Could not check the code right now.' });
  }
};
