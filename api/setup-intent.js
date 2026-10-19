// POST /api/setup-intent
// Body: the in-progress record (store, locations, groups, systems, owner, referral).
// Creates one Stripe customer per signup and a SetupIntent that vaults the card.
// Nothing is charged. Subscriptions are created at activation.
//
// Security model: the response carries a `session` token (HMAC of the customer id).
// Any later call that names a customerId — here, /api/accept, /api/lead — must present
// it. Customer ids appear in emails and URLs; the session token never does.
const { stripeClient } = require('../lib/stripe');
const config = require('../lib/config');
const record = require('../lib/record');
const stores = require('../lib/stores');
const sec = require('../lib/security');


function validate(b) {
  const v = sec.v;
  const store = b.store || {};
  const o = store.overrides || {};
  const owner = b.owner || {};
  const sys = b.systems || {};
  const out = {
    store: {
      chain: v.slug(store.chain), chainName: v.str(store.chainName, 120), agcoName: v.optStr(store.agcoName, 120),
      extra: Array.isArray(store.extra) && store.extra.length <= 10 ? store.extra.map(v.slug) : undefined,
      overrides: { name: v.optStr(o.name, 120), phone: v.optStr(o.phone, 30), website: v.optStr(o.website, 200) },
    },
    entryStoreId: b.entryStoreId ? v.crsaList([b.entryStoreId])?.[0] : null,
    locations: v.crsaList(b.locations),
    groups: Array.isArray(b.groups) && b.groups.length <= 20 ? b.groups.map(g => ({ name: v.str(g && g.name, 60), ids: v.crsaList(g && g.ids) })) : undefined,
    // Chips are a fixed list but 'Other' lets the retailer type their provider — accept any short string.
    systems: { pos: v.optStr(sys.pos, 60), processor: v.optStr(sys.processor, 60), ecommerce: v.optStr(sys.ecommerce, 60), delivery: sys.delivery == null ? null : !!sys.delivery, deliverySoftware: v.optStr(sys.deliverySoftware, 60) },
    owner: { name: v.str(owner.name, 120), email: v.email(owner.email), mobile: v.optStr(owner.mobile, 30) },
    referral: b.referral ? { code: v.str(b.referral.code, 32) } : null,
    customerId: b.customerId ? String(b.customerId) : null,
    session: b.session ? String(b.session) : null,
  };
  const bad = [];
  const walk = (x, p) => { for (const k in x) { const val = x[k]; if (val === undefined) bad.push(p + k); else if (val && typeof val === 'object' && !Array.isArray(val)) walk(val, p + k + '.'); else if (Array.isArray(val)) val.forEach((e, i) => { if (e === undefined) bad.push(`${p}${k}[${i}]`); else if (e && typeof e === 'object') walk(e, `${p}${k}[${i}].`); }); } };
  walk(out, '');
  if (out.store.overrides.website && !/^https?:\/\//i.test(out.store.overrides.website)) out.store.overrides.website = 'https://' + out.store.overrides.website;
  return { rec: out, bad };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!config.STRIPE_SECRET_KEY) return res.status(503).json({ error: 'Stripe is not configured.' });
  if (!sec.sameOrigin(req)) return res.status(403).json({ error: 'Forbidden' });
  const ip = sec.clientIp(req);
  if (!sec.rateLimit(`si:${ip}`, 20, 60e3)) return sec.tooMany(res);
  const raw = sec.body(req);
  if (!raw) return res.status(400).json({ error: 'Bad request.' });
  const { rec: b, bad } = validate(raw);
  if (bad.length) return res.status(400).json({ error: 'Some fields are missing or invalid.', fields: bad.slice(0, 10) });
  const stripe = stripeClient();

  try {
    // Re-validate locations against the AGCO index — the client only sends ids. Dedupe by licence.
    const seen = new Set();
    const locs = b.locations.map(id => stores.store(id)).filter(s => s && !seen.has(s.id) && seen.add(s.id))
      .map(s => ({ id: s.id, name: s.name, addr: s.addr, city: s.city, postal: s.postal, lat: s.lat, lng: s.lng }));
    if (!locs.length) return res.status(400).json({ error: 'Those locations are not on the AGCO authorized list.' });
    const locIds = new Set(locs.map(l => l.id));
    const groups = b.groups.map(g => ({ name: g.name, ids: g.ids.filter(id => locIds.has(id)) })).filter(g => g.ids.length);

    const rec = { store: b.store, entryStoreId: b.entryStoreId, locations: locs, groups, systems: b.systems, owner: b.owner, referral: b.referral, acceptance: null };

    let customer;
    if (b.customerId) {
      // Retailer went back and changed something — update, don't duplicate. Only with the session token.
      if (!sec.checkSession(b.customerId, b.session)) return res.status(403).json({ error: 'Session expired. Please reload the page.' });
      const prev = await stripe.customers.retrieve(b.customerId).catch(() => null);
      if (!prev || prev.deleted) return res.status(404).json({ error: 'Signup not found. Please reload the page.' });
      const prevRec = record.unpack(prev.metadata || {});
      if (prevRec && prevRec.acceptance && prevRec.acceptance.at) return res.status(409).json({ error: 'This signup is already complete.' });
      customer = await stripe.customers.update(b.customerId, {
        name: b.store.chainName, email: b.owner.email, phone: b.owner.mobile || undefined,
        metadata: record.pack(rec, record.chunksIn(prev.metadata)),
      });
    } else {
      customer = await stripe.customers.create({
        name: b.store.chainName,
        email: b.owner.email,
        phone: b.owner.mobile || undefined,
        description: `Poof retailer — ${b.store.chainName} (${locs.length})`,
        metadata: record.pack(rec),
        address: { line1: locs[0].addr, city: locs[0].city, state: 'ON', postal_code: locs[0].postal, country: 'CA' },
      });
    }

    const si = await stripe.setupIntents.create({
      customer: customer.id,
      payment_method_types: ['card'],
      usage: 'off_session',
      metadata: { poof_store_name: b.store.chainName, locations: String(locs.length) },
    });

    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(200).json({ clientSecret: si.client_secret, customerId: customer.id, setupIntentId: si.id, session: sec.sessionToken(customer.id), locations: locs });
  } catch (err) {
    console.error('setup-intent failed:', { ip, err: err.message });
    return res.status(500).json({ error: 'Could not start the payment step.' });
  }
};
