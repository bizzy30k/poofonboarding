// Poof HQ core integration.
//
// Core (api.poof.ca/v1) is the system of record for stores. This module turns an
// onboarding signup record into core's EXACT store document shape — field names
// and nesting copied from GET /v1/admin/store/:id on production — so core can
// upsert it without translation. One core store = one AGCO licence (CRSA), so a
// multi-location signup produces one document per location.
//
// Two delivery paths, both optional and both non-blocking for the retailer:
//   push: POST {CORE_WEBHOOK_URL}  — signed JSON envelope on accept / activate
//   pull: GET  /api/core-export    — admin-key endpoint, same envelope, filterable
//
// Join key on core's side: license.licenseNumber (CRSA). Everything the retailer
// typed is in the document; everything Poof-side (Stripe ids, agreement,
// stage) is under `poof` so core can keep it or drop it.
const config = require('./config');
const stores = require('./stores');

const slugify = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_-]+/g, '-').replace(/^-+|-+$/g, '');
const titleCase = (s) => String(s || '').toLowerCase().replace(/(^|[\s\-(/])([a-z])/g, (m, p, c) => p + c.toUpperCase());
const digits = (s) => String(s || '').replace(/\D/g, '');
const clean = (s) => (s == null || s === '' ? null : String(s).trim());

// AGCO addresses are shouty ("527 SANDWICH ST S UNIT 440"); core stores them in
// title case ("Shop 9, 1881 Steeles Avenue West"). Title-case, keep unit tokens.
function prettyAddress(addr) {
  return titleCase(addr).replace(/\b(Unit|Suite|Shop|Bldg|Ste)\b\s*/gi, (m) => titleCase(m));
}

/**
 * One core store document for one AGCO location on a signup record.
 * @param {object} rec       unpacked onboarding record (lib/record.unpack)
 * @param {object} loc       { id, name, addr, city, postal, lat, lng }
 * @param {object} extra     { customerId, orderFormUrl, stage, subscriptionId }
 */
function toCoreStore(rec, loc, extra = {}) {
  const idx = stores.store(loc.id) || {};
  const chainName = clean(rec.store?.overrides?.name) || rec.store?.chainName || idx.chainName || loc.name;
  const storeName = titleCase(loc.name || idx.name || chainName);
  const address = prettyAddress(loc.addr || idx.addr);
  const city = titleCase(loc.city || idx.city);
  const website = clean(rec.store?.overrides?.website) || clean(idx.website) || null;
  const sys = rec.systems || {};
  const own = rec.owner || {};
  const acc = rec.acceptance || null;
  const group = (rec.groups || []).find(g => (g.ids || []).includes(loc.id));

  return {
    // ---- identity (core: name / displayAs / slug) ----
    name: storeName,
    displayAs: chainName,
    slug: slugify(`${storeName}-${address}-${city}`),
    description: null,
    imageUrl: null,
    source: 'onboarding',                         // core uses "imported" for AGCO loads

    // ---- licence (join key) ----
    license: { licenseNumber: loc.id, licenseName: storeName, dateRegistered: null, dateExpired: null },

    // ---- location ----
    location: { address, city, province: 'ON', country: 'Canada', postalCode: (loc.postal || idx.postal || '').toUpperCase() },
    geolocation: (loc.lng != null && loc.lat != null) ? { type: 'Point', coordinates: [loc.lng, loc.lat] } : null,

    // ---- contact (account owner from the flow) ----
    contactName: clean(own.name),
    contactEmail: clean(own.email && own.email.toLowerCase()),
    contactNumber: digits(rec.store?.overrides?.phone || own.mobile) || null,
    website,
    facebookUrl: null, instagramUrl: null, xUrl: null,

    // ---- systems (steps 8–13 of the HQ dispensary form) ----
    posIntegration: clean(sys.pos) || null,
    paymentSolution: clean(sys.processor) || null,
    acceptablePayment: [],
    breadStackIntegration: /breadstack/i.test(sys.ecommerce || '') ? { requested: true } : {},
    deliveryInformation: { hasDelivery: !!sys.delivery, note: sys.delivery ? (clean(sys.deliverySoftware) || null) : null },
    deliveryZones: [],
    operationHours: null,                         // not collected in the flow; HQ step 7

    // ---- state flags (core decides; these are the safe defaults for a new signup) ----
    isActive: false,
    isValidated: false,
    isProfileComplete: false,

    // ---- Poof-side facts core may keep (namespaced so nothing collides) ----
    poof: {
      stripeCustomerId: extra.customerId || rec.customerId || null,
      stripeSubscriptionId: extra.subscriptionId || null,
      stage: extra.stage || (acc ? 'accepted' : 'in_progress'),   // in_progress | accepted | live
      entryStoreId: rec.entryStoreId || null,
      chainSlug: rec.store?.chain || idx.chain || null,
      group: group ? group.name : null,
      ecommerce: clean(sys.ecommerce) || null,
      cardOnFile: acc ? !rec.cardSkipped : null,
      offer: rec.offer ? { code: rec.offer.code, months: rec.offer.months } : null,
      referralCode: rec.referral?.code || null,
      agreement: acc ? { acceptedBy: acc.name, title: acc.title, at: acc.at, termsVersion: acc.termsVersion, termsHash: acc.termsHash, ip: acc.ip } : null,
      orderFormUrl: extra.orderFormUrl || null,
      onboardingUrl: `${config.SITE_URL}/s/${loc.id}`,
    },
  };
}

/** Envelope for one signup: the account plus one core store per location. */
function toCoreSignup(rec, extra = {}) {
  const locs = rec.locations || [];
  return {
    event: extra.event || 'signup.accepted',
    sentAt: new Date().toISOString(),
    account: {
      stripeCustomerId: extra.customerId || rec.customerId || null,
      chainName: clean(rec.store?.overrides?.name) || rec.store?.chainName || null,
      chainSlug: rec.store?.chain || null,
      owner: { name: clean(rec.owner?.name), email: clean(rec.owner?.email && rec.owner.email.toLowerCase()), mobile: digits(rec.owner?.mobile) || null },
      locationCount: locs.length,
      groups: (rec.groups || []).map(g => ({ name: g.name, licenseNumbers: g.ids })),
      conflicts: (rec.conflicts || []).map(c => ({ stripeCustomerId: c.customerId, licenseNumbers: c.overlap, stage: c.stage })),
    },
    stores: locs.map(l => toCoreStore(rec, l, extra)),
  };
}

/**
 * Push the envelope to core. Fire-and-forget: errors are returned, never thrown.
 * Core verifies with HMAC-SHA256 over the raw body using CORE_WEBHOOK_SECRET.
 */
async function notifyCore(rec, extra = {}) {
  const url = config.CORE_WEBHOOK_URL;
  if (!url) return { skipped: 'CORE_WEBHOOK_URL not set' };
  if (!config.CORE_WEBHOOK_SECRET) return { error: 'CORE_WEBHOOK_SECRET not set — refusing to send unsigned' };
  const crypto = require('crypto');
  const id = crypto.randomUUID();
  const envelope = { id, ...toCoreSignup(rec, extra) };   // id + sentAt are inside the signed body → replay-detectable
  const body = JSON.stringify(envelope);
  const sig = crypto.createHmac('sha256', config.CORE_WEBHOOK_SECRET).update(body).digest('hex');
  const headers = { 'Content-Type': 'application/json', 'x-poof-event': envelope.event, 'x-poof-id': id, 'x-poof-signature': sig, 'x-poof-source': 'onboarding.poof.ca', 'User-Agent': 'poof-onboarding' };
  // Two attempts, 5s each. Beyond that core reconciles via /api/core-export.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(5000) });
      if (r.ok) return { ok: true, status: r.status, id };
      if (r.status < 500) return { ok: false, status: r.status, id };
    } catch (e) { if (attempt === 2) return { error: e.message, id }; }
  }
  return { ok: false, id };
}

module.exports = { toCoreStore, toCoreSignup, notifyCore };
