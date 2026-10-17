// GET /api/orderform?c=cus_…&t=<signature>  → the Order Form PDF, regenerated
// from the Stripe customer record. The link is in the retailer's email and on
// the success screen; the signature stops anyone guessing customer ids.
const Stripe = require('stripe');
const config = require('../lib/config');
const record = require('../lib/record');
const { buildOrderForm } = require('../lib/orderform');

module.exports = async (req, res) => {
  const { c, t } = req.query || {};
  if (!/^cus_[A-Za-z0-9]+$/.test(c || '') || config.sign(c) !== t) return res.status(403).send('Invalid link.');
  try {
    const stripe = new Stripe(config.STRIPE_SECRET_KEY);
    const customer = await stripe.customers.retrieve(c);
    const rec = record.unpack(customer.metadata || {});
    if (!rec) return res.status(404).send('No order form on file.');
    rec.customerId = c;
    const pdf = await buildOrderForm(rec);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="Poof-Order-Form-${rec.store.chainName.replace(/[^a-z0-9]+/gi, '-')}.pdf"`);
    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(200).send(pdf);
  } catch (e) {
    console.error('orderform failed:', e);
    return res.status(500).send('Could not build the order form.');
  }
};
