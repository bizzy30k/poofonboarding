// /api/claim — "Claim your listing": the step before signup.
//
// The owner lands on /claim/<CRSA>, confirms the store, and fills ONE form. Required: name, email,
// logo, phone, website, description, hours. Optional: public email, Instagram. Nothing else.
//
// GET  /api/claim?id=CRSA…          → { claimed: false } | { claimed: true, claimedAt, storeName, status }
// GET  /api/claim?id=CRSA…&t=<tok>  → same, plus { contact, listing, siblings } when the token is the owner's
//                                      edit token (from their confirmation email) — prefills the form.
// POST /api/claim                   → saves the claim. On submit we:
//   1. store the logo (public URL) and the record (encrypted) in Vercel Blob   — lib/claims.js
//   2. email the owner the fixed "Awesome. This has been updated." copy        — lib/mail.js
//   3. email the onboarding inbox the logo link + core-shaped fields            — lib/mail.js
//   4. fire Klaviyo `Listing Claimed` (profile: email, first_name, store)      — lib/klaviyo.js
// Nothing goes live by itself: you review it, put it in HQ, then publish via POST /api/claims.
//
// LOCK: the first claim wins. A second POST for the same CRSA is refused with 409 unless it carries
// the owner's edit token (`t`). To hand a listing to someone else, an admin releases it (POST /api/claims
// action=release) after the owner writes in.
//
// Body: { id, name, email, turnstile?, t?, listing: { logo?, phone?, email?, website?, instagram?, description?, hours? } }
//   logo:   data URL (image/png|jpeg|webp, ≤600 KB — the page resizes to ≤512px first). May be omitted
//           on an edit when a logo is already on file.
//   hours:  { monday: { open:'10:00 AM', close:'10:00 PM' } | null, … sunday } — at least one open day
// Reply: { ok, id, logoUrl, revision, token, chainName, siblings: [{ id, name, addr, city }] }
//   token    — the owner's edit token (also in their email); the page uses it for "claim the rest"
//   siblings — unclaimed stores on the same licence
const sec = require('../lib/security');
const config = require('../lib/config');
const stores = require('../lib/stores');
const claims = require('../lib/claims');
const { sendClaimEmails } = require('../lib/mail');
const { places } = require('../lib/places');
const klaviyo = require('../lib/klaviyo');
const hq = require('../lib/hq');

const CRSA = /^CRSA\d{6,8}$/;
const cleanId = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

async function getStatus(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!sec.rateLimit(`claim:status:${sec.clientIp(req)}`, 120, 3600e3)) return sec.tooMany(res);
  const q = req.query || {};
  const id = cleanId(q.id);
  const store = CRSA.test(id) ? stores.store(id) : null;
  if (!store) return res.status(404).json({ error: 'No such store.' });
  const rec = await claims.getRecord(id).catch(() => null);
  const out = claims.publicStatus(rec);
  if (rec && claims.checkEditToken(rec, q.t)) {
    out.owner = true;
    out.contact = rec.contact;
    out.listing = rec.listing;
    out.siblings = await claims.unclaimedSiblings(store, stores.chain(store.chain));
  }
  return res.status(200).json(out);
}

module.exports = async (req, res) => {
  if (req.method === 'GET') return getStatus(req, res);
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!sec.sameOrigin(req)) return res.status(403).json({ error: 'Forbidden' });
  const ip = sec.clientIp(req);
  if (!sec.rateLimit(`claim:try:${ip}`, 30, 3600e3)) return sec.tooMany(res); // loose brake on attempts; the strict one is below, after validation

  const b = sec.body(req);
  if (!b) return res.status(400).json({ error: 'Bad request.' });
  if (b.website) return res.status(200).json({ ok: true }); // honeypot — the page never sends a top-level `website`

  const id = cleanId(b.id);
  const store = CRSA.test(id) ? stores.store(id) : null;
  if (!store) return res.status(404).json({ error: 'No such store.' });

  const name = sec.v.str(b.name, 120);
  const email = sec.v.email(b.email);
  if (!name) return res.status(400).json({ error: 'Your name, please.', fields: ['name'] });
  if (!email) return res.status(400).json({ error: "That email doesn't look right.", fields: ['email'] });

  const ts = await sec.verifyTurnstile(b.turnstile, ip);
  if (!ts.ok) return res.status(403).json({ error: 'Verification failed. Please reload and try again.' });

  const L = b.listing && typeof b.listing === 'object' ? b.listing : {};
  const fields = {
    logo: claims.v.logo(L.logo),
    phone: claims.v.phone(L.phone),
    email: L.email == null || L.email === '' ? '' : sec.v.email(L.email),
    website: claims.v.website(L.website),
    instagram: claims.v.instagram(L.instagram),
    description: sec.v.optStr(L.description, 300),
    hours: claims.v.hours(L.hours),
  };
  const bad = Object.keys(fields).filter(k => fields[k] === undefined);
  if (bad.length) return res.status(400).json({ error: `Please check: ${bad.join(', ')}.`, fields: bad });
  // Bare minimum for a claimed listing: phone, website, description, hours (logo checked below, once we know if one is on file)
  const missing = ['phone', 'website', 'description'].filter(k => !fields[k]);
  if (missing.length) return res.status(400).json({ error: `Required: ${missing.join(', ')}.`, fields: missing });

  try {
    const prev = await claims.getRecord(id).catch(() => null);
    if (prev && !claims.checkEditToken(prev, b.t)) {
      // Locked. Don't reveal who claimed it; the page shows "already claimed — not you? contact@poof.ca".
      return res.status(409).json({ error: 'already_claimed', claimedAt: prev.claimedAt || prev.submittedAt, storeName: prev.storeName });
    }
    // Strict brakes count accepted submissions only, so a typo (or a stranger hitting a locked store) doesn't lock a real owner out.
    if (!sec.rateLimit(`claim:ip:${ip}`, 5, 3600e3) || !sec.rateLimit(`claim:store:${id}`, 6, 3600e3)) return sec.tooMany(res);
    let logoUrl = prev && prev.listing ? prev.listing.logoUrl || null : null;
    const needsReview = [];
    if (fields.logo) logoUrl = await claims.putLogo(id, fields.logo);
    else if (L.logoFrom === 'google') {
      // "Use my Google photo": fetched server-side so the Places key stays private
      const p = await require('../lib/places').photo(store);
      if (!p) return res.status(400).json({ error: "Google doesn't have a photo for this store — upload one, or email it to us later.", fields: ['logo'] });
      logoUrl = await claims.putLogo(id, p);
      needsReview.push('logo is the Google photo, not a logo');
    } else if (L.logoLater === true && !logoUrl) {
      needsReview.push('no logo yet — owner will email it');
    } else if (!logoUrl) return res.status(400).json({ error: 'Upload your logo.', fields: ['logo'] });

    const now = new Date().toISOString();
    const rec = {
      id,
      storeName: store.chainName || store.name,
      chain: store.chain,
      location: { name: store.name, addr: store.addr, city: store.city, postal: store.postal },
      status: 'pending', // an edit always goes back through review; publishedAt/liveUrl are kept so /admin can show "edited since publish"
      editedSincePublish: !!(prev && prev.status === 'published'),
      revision: prev ? (prev.revision || 1) + 1 : 1,
      claimedAt: prev ? prev.claimedAt || prev.submittedAt : now,
      submittedAt: now,
      publishedAt: prev && prev.publishedAt ? prev.publishedAt : null,
      liveUrl: prev && prev.liveUrl ? prev.liveUrl : null,
      contact: prev ? prev.contact : { name, email }, // the lock holder stays the contact; an edit can't hand the listing to a new email
      editor: prev && prev.contact.email.toLowerCase() !== email.toLowerCase() ? { name, email } : undefined,
      listing: { logoUrl, phone: fields.phone, email: fields.email, website: fields.website, instagram: fields.instagram, description: fields.description, hours: fields.hours },
      needsReview: needsReview.length ? needsReview : undefined,
      ip,
      source: 'onboarding.poof.ca/claim',
    };
    const [siblings, google, hqRec] = await Promise.all([
      claims.unclaimedSiblings(store, stores.chain(store.chain)),
      places(store).catch(() => null), // usually cached from the page's prefill call; only feeds the ownership verdict
      hq.match(store).catch(() => null), // Poof HQ store id (read-only lookup) — travels with the record, the email and Stripe
    ]);
    rec.hq = hqRec || (prev && prev.hq) || null;
    await claims.putRecord(rec);

    const token = claims.editToken(id, rec.contact.email);
    const core = claims.toCoreListing(rec);
    const out = { ok: true, id, logoUrl, revision: rec.revision, token, chainName: rec.storeName, siblings };
    const mail = await sendClaimEmails(rec, core, { token, siblings: siblings.length, google, logoLater: !logoUrl });
    if (mail.retailer && mail.retailer.error) console.error('claim: retailer mail failed', mail.retailer.error);
    if (mail.internal && mail.internal.error) console.error('claim: internal mail failed', mail.internal.error);
    const k = await klaviyo.track('Listing Claimed', rec.contact.email, {
      store: rec.storeName, entry_store: id, chain: rec.chain, first_name: rec.contact.name.split(' ')[0] || '',
      logo: !!logoUrl, hours: !!fields.hours, description: !!fields.description, revision: rec.revision,
      locations: 1, unclaimed_siblings: siblings.length,
      pos_url: `${config.SITE_URL}/s/${id}?t=${token}&utm_source=klaviyo&utm_medium=email&utm_campaign=claimed-not-connected`,
      edit_url: `${config.SITE_URL}/claim/${id}?t=${token}`,
      hq_store_id: rec.hq ? rec.hq.id : '', hq_url: rec.hq ? rec.hq.url : '',
    }, {
      claimed_at: rec.claimedAt, chain: rec.chain, store_count: 1, last_claim_store: id, claim_source: 'onboarding.poof.ca',
    }).catch(e => ({ error: e.message }));
    if (k && k.error) console.error('claim: klaviyo failed', k.error);
    return res.status(200).json(out);
  } catch (e) {
    console.error('claim: failed', { id, err: e.message });
    return res.status(500).json({ error: 'Something went wrong saving your listing. Please try again.' });
  }
};
