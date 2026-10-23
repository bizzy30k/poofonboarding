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
// Join key on core's side: `id` (core's store id, found by licenseNumber = CRSA via lib/hq.js). Everything the retailer
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

// ---- our claim hours → core operationHours ({ mon: { startTime: '10:00', endTime: '23:00' } | null, … }) ----
const CORE_DAYS = { monday: 'mon', tuesday: 'tue', wednesday: 'wed', thursday: 'thu', friday: 'fri', saturday: 'sat', sunday: 'sun' };
function to24(t) {
  const m = /^(\d{1,2}):(\d{2}) ([AP]M)$/.exec(String(t || '').trim());
  if (!m) return null;
  let h = Number(m[1]) % 12; if (m[3] === 'PM') h += 12;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}
function hoursToCore(hours) {
  if (!hours || typeof hours !== 'object') return null;
  const out = {};
  for (const [ours, theirs] of Object.entries(CORE_DAYS)) {
    const d = hours[ours];
    out[theirs] = d && to24(d.open) && to24(d.close) ? { startTime: to24(d.open), endTime: to24(d.close) } : null;
  }
  return out;
}

/**
 * Core's store document, field for field as GET /admin/store/list-unclaimed returns it (Omid, Oct 2026).
 * `coreRow` is the store's current document in core (lib/hq.row) — everything we don't collect keeps core's
 * value; `ours` overrides what the retailer gave us. `id` is core's own store id, so core upserts in place.
 */
function storeDocument(coreRow, idx, ours = {}) {
  const r = coreRow || {};
  const address = r.location && r.location.address ? r.location.address : prettyAddress(idx.addr);
  const city = r.location && r.location.city ? r.location.city : titleCase(idx.city);
  const base = {
    id: r.id || null,
    source: r.source || 'imported',
    slug: r.slug || slugify(`${idx.chainName || idx.name}-${idx.addr}-${idx.city}`),
    name: r.name || titleCase(idx.chainName || idx.name),
    displayAs: r.displayAs || r.name || titleCase(idx.chainName || idx.name),
    contactName: r.contactName || null,
    contactEmail: r.contactEmail || null,
    contactNumber: r.contactNumber || null,
    location: { address, postalCode: (r.location && r.location.postalCode) || (idx.postal || '').toUpperCase(), city, province: (r.location && r.location.province) || 'ON', country: 'Canada' },
    geolocation: r.geolocation || ((idx.lng != null && idx.lat != null) ? { type: 'Point', coordinates: [idx.lng, idx.lat] } : null),
    operationHours: r.operationHours || null,
    acceptablePayment: r.acceptablePayment || [],
    deliveryInformation: r.deliveryInformation || { hasDelivery: false, note: null },
    deliveryZones: r.deliveryZones || [],
    imageUrl: r.imageUrl || null,
    isValidated: !!r.isValidated,
    isProfileComplete: !!r.isProfileComplete,
    description: r.description || null,
    website: r.website || null,
    facebookUrl: r.facebookUrl || null,
    instagramUrl: r.instagramUrl || null,
    xUrl: r.xUrl || null,
    reviewCount: r.reviewCount || 0,
    reviewRate: r.reviewRate || 0,
    totalProductReview: r.totalProductReview || 0,
    licenseNumber: r.licenseNumber || idx.id,
    owner: r.owner || null,
  };
  const doc = { ...base };
  for (const [k, v] of Object.entries(ours)) if (v !== undefined) doc[k] = v;
  doc.isProfileComplete = !!(doc.imageUrl && doc.description && doc.operationHours && doc.contactNumber && doc.website);
  return doc;
}

/**
 * One core store document for one AGCO location on a signup record.
 * @param {object} rec       unpacked onboarding record (lib/record.unpack)
 * @param {object} loc       { id, name, addr, city, postal, lat, lng }
 * @param {object} extra     { customerId, orderFormUrl, stage, subscriptionId }
 * @param {object} coreRow   the store's current document in core (lib/hq.row), when known
 */
function toCoreStore(rec, loc, extra = {}, coreRow = null) {
  const idx = { ...(stores.store(loc.id) || {}), ...loc };
  const chainName = clean(rec.store?.overrides?.name) || rec.store?.chainName || idx.chainName || loc.name;
  const sys = rec.systems || {};
  const own = rec.owner || {};
  const acc = rec.acceptance || null;
  const group = (rec.groups || []).find(g => (g.ids || []).includes(loc.id));
  const hqId = rec.hq && rec.hq[loc.id] ? rec.hq[loc.id].id : null;

  const doc = storeDocument(coreRow, { ...idx, chainName }, {
    id: (coreRow && coreRow.id) || hqId || null,
    displayAs: chainName,
    contactName: clean(own.name) || undefined,
    contactEmail: clean(own.email && own.email.toLowerCase()) || undefined,
    contactNumber: digits(rec.store?.overrides?.phone || own.mobile) || undefined,
    website: clean(rec.store?.overrides?.website) || undefined,
    deliveryInformation: sys.delivery == null ? undefined : { hasDelivery: !!sys.delivery, note: sys.delivery ? (clean(sys.deliverySoftware) || null) : null },
  });

  // ---- Poof-side facts core may keep (namespaced so nothing collides with the document above) ----
  doc.poof = {
    hqStoreId: doc.id,
    stripeCustomerId: extra.customerId || rec.customerId || null,
    stripeSubscriptionId: extra.subscriptionId || null,
    stage: extra.stage || (acc ? 'accepted' : 'in_progress'),   // in_progress | accepted | live
    entryStoreId: rec.entryStoreId || null,
    chainSlug: rec.store?.chain || idx.chain || null,
    group: group ? group.name : null,
    posIntegration: clean(sys.pos) || null,
    paymentSolution: clean(sys.processor) || null,
    ecommerce: clean(sys.ecommerce) || null,
    cardOnFile: acc ? !rec.cardSkipped : null,
    offer: rec.offer ? { code: rec.offer.code, months: rec.offer.months } : null,
    referralCode: rec.referral?.code || null,
    agreement: acc ? { acceptedBy: acc.name, title: acc.title, at: acc.at, termsVersion: acc.termsVersion, termsHash: acc.termsHash, ip: acc.ip } : null,
    orderFormUrl: extra.orderFormUrl || null,
    onboardingUrl: `${config.SITE_URL}/s/${loc.id}`,
  };
  return doc;
}

/** Envelope for one signup: the account plus one core store per location (each merged over core's current row). */
async function toCoreSignup(rec, extra = {}) {
  const locs = rec.locations || [];
  const hq = require('./hq');
  const docs = [];
  for (const l of locs) docs.push(toCoreStore(rec, l, extra, await hq.row({ ...l, chainName: rec.store?.chainName }).catch(() => null)));
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
    stores: docs,
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
  const envelope = { id, ...(await toCoreSignup(rec, extra)) };   // id + sentAt are inside the signed body → replay-detectable
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

module.exports = { toCoreStore, toCoreSignup, notifyCore, storeDocument, hoursToCore };
