// POST /api/setup-intent
// Body: the in-progress record (store, locations, groups, systems, owner, referral).
// Creates one Stripe customer per signup and a SetupIntent that vaults the card.
// Nothing is charged. Subscriptions are created at activation.
const Stripe = require('stripe');
const config = require('../lib/config');
const record = require('../lib/record');
const stores = require('../lib/stores');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!config.STRIPE_SECRET_KEY) return res.status(500).json({ error: 'Stripe is not configured.' });
  const stripe = new Stripe(config.STRIPE_SECRET_KEY);

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { store, locations, groups, systems, owner, referral, customerId, entryStoreId } = body;
    if (!store?.chainName || !owner?.email || !owner?.name) return res.status(400).json({ error: 'Store and account owner are required.' });
    if (!Array.isArray(locations) || !locations.length) return res.status(400).json({ error: 'Pick at least one location.' });

    // Re-validate locations against the AGCO index — the client only sends ids.
    const locs = locations.map(id => stores.store(typeof id === 'string' ? id : id.id)).filter(Boolean)
      .map(s => ({ id: s.id, name: s.name, addr: s.addr, city: s.city, postal: s.postal, lat: s.lat, lng: s.lng }));
    if (!locs.length) return res.status(400).json({ error: 'Those locations are not on the AGCO authorized list.' });

    const rec = { store, entryStoreId: entryStoreId || null, locations: locs, groups: groups || [], systems: systems || {}, owner, referral: referral || null, acceptance: null };

    let customer;
    if (customerId && /^cus_/.test(customerId)) {
      // Retailer went back and changed something — update, don't duplicate.
      const prev = await stripe.customers.retrieve(customerId).catch(() => null);
      const meta = record.pack(rec, prev ? record.chunksIn(prev.metadata) : 0);
      customer = prev
        ? await stripe.customers.update(customerId, { name: store.chainName, email: owner.email, phone: owner.mobile || undefined, metadata: meta })
        : await stripe.customers.create({ name: store.chainName, email: owner.email, phone: owner.mobile || undefined, description: `Poof retailer — ${store.chainName} (${locs.length})`, metadata: meta });
    } else {
      const meta = record.pack(rec);
      customer = await stripe.customers.create({
        name: store.chainName,
        email: owner.email,
        phone: owner.mobile || undefined,
        description: `Poof retailer — ${store.chainName} (${locs.length})`,
        metadata: meta,
        address: { line1: locs[0].addr, city: locs[0].city, state: 'ON', postal_code: locs[0].postal, country: 'CA' },
      });
    }

    const si = await stripe.setupIntents.create({
      customer: customer.id,
      payment_method_types: ['card'],
      usage: 'off_session',
      metadata: { poof_store_name: store.chainName, locations: String(locs.length) },
    });

    return res.status(200).json({ clientSecret: si.client_secret, customerId: customer.id, setupIntentId: si.id, locations: locs });
  } catch (err) {
    console.error('setup-intent failed:', err);
    return res.status(500).json({ error: 'Could not start the payment step.' });
  }
};
