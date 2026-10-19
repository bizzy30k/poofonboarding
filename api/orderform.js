// GET /api/orderform?c=cus_…&t=<signature>  → the Order Form PDF, regenerated
// from the Stripe customer record. The link is in the retailer's email and on
// the success screen; the signature stops anyone guessing customer ids.
const Stripe = require('stripe');
const config = require('../lib/config');
const record = require('../lib/record');
const { buildOrderForm } = require('../lib/orderform');
const sec = require('../lib/security');

module.exports = async (req, res) => {
  if (!sec.rateLimit(`of:${sec.clientIp(req)}`, 30, 60e3)) return res.status(429).send('Too many requests.');
  const { c, t } = req.query || {};
  if (!/^cus_[A-Za-z0-9]+$/.test(c || '') || !config.checkOrderFormToken(c, t)) return res.status(403).send('This link is invalid or has expired. Reply to your welcome email and we\'ll send a fresh one.');
  try {
    const stripe = new Stripe(config.STRIPE_SECRET_KEY);
    const customer = await stripe.customers.retrieve(c);
    const rec = record.unpack(customer.metadata || {});
    if (!rec) return res.status(404).send('No order form on file.');
    rec.customerId = c;
    const pdf = await buildOrderForm(rec);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="Poof-Order-Form-${String(rec.store.chainName).replace(/[^a-z0-9]+/gi, '-')}.pdf"`);
    res.setHeader('X-Robots-Tag', 'noindex');
    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(200).send(pdf);
  } catch (e) {
    console.error('orderform failed:', e);
    return res.status(500).send('Could not build the order form.');
  }
};
