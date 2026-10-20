// POST /api/claim — "Claim your listing": the step before signup.
//
// The owner lands on /claim/<CRSA>, confirms the store, gives a name + email, and fills ONE
// form: logo, phone, public email, website, Instagram, description, hours. Nothing else.
// On submit we:
//   1. store the logo (public URL) and the record (private) in Vercel Blob   — lib/claims.js
//   2. email the owner the fixed "Awesome. This has been updated." copy      — lib/mail.js
//   3. email the onboarding inbox the logo link + core-shaped fields          — lib/mail.js
//   4. fire Klaviyo `Listing Claimed` (profile: email, first_name, store)    — lib/klaviyo.js
// Nothing goes live by itself: you review it, put it in HQ, then publish via POST /api/claims.
//
// Body: { id, name, email, turnstile?, listing: { logo?, phone?, email?, website?, instagram?, description?, hours? } }
//   logo:   data URL (image/png|jpeg|webp, ≤600 KB — the page resizes to ≤512px first)
//   hours:  { monday: { open:'10:00', close:'22:00' } | null, … sunday } | null
// Reply: { ok, id, logoUrl, revision }
const sec = require('../lib/security');
const stores = require('../lib/stores');
const claims = require('../lib/claims');
const { sendClaimEmails } = require('../lib/mail');
const klaviyo = require('../lib/klaviyo');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!sec.sameOrigin(req)) return res.status(403).json({ error: 'Forbidden' });
  const ip = sec.clientIp(req);
  if (!sec.rateLimit(`claim:try:${ip}`, 30, 3600e3)) return sec.tooMany(res); // loose brake on attempts; the strict one is below, after validation

  const b = sec.body(req);
  if (!b) return res.status(400).json({ error: 'Bad request.' });
  if (b.website) return res.status(200).json({ ok: true }); // honeypot — the page never sends a top-level `website`

  const id = String(b.id || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const store = /^CRSA\d{6,8}$/.test(id) ? stores.store(id) : null;
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

  // Strict brakes count accepted submissions only, so a typo doesn't lock a real owner out.
  if (!sec.rateLimit(`claim:ip:${ip}`, 5, 3600e3) || !sec.rateLimit(`claim:store:${id}`, 3, 3600e3)) return sec.tooMany(res);

  try {
    const prev = await claims.getRecord(id).catch(() => null);
    let logoUrl = prev && prev.listing ? prev.listing.logoUrl || null : null;
    if (fields.logo) logoUrl = await claims.putLogo(id, fields.logo);

    const rec = {
      id,
      storeName: store.chainName || store.name,
      chain: store.chain,
      location: { name: store.name, addr: store.addr, city: store.city, postal: store.postal },
      status: 'pending',
      revision: prev ? (prev.revision || 1) + 1 : 1,
      submittedAt: new Date().toISOString(),
      publishedAt: prev && prev.publishedAt ? prev.publishedAt : null,
      liveUrl: prev && prev.liveUrl ? prev.liveUrl : null,
      contact: { name, email },
      listing: { logoUrl, phone: fields.phone, email: fields.email, website: fields.website, instagram: fields.instagram, description: fields.description, hours: fields.hours },
      ip,
      source: 'onboarding.poof.ca/claim',
    };
    await claims.putRecord(rec);

    const core = claims.toCoreListing(rec);
    const out = { ok: true, id, logoUrl, revision: rec.revision };
    const mail = await sendClaimEmails(rec, core);
    if (mail.retailer && mail.retailer.error) console.error('claim: retailer mail failed', mail.retailer.error);
    if (mail.internal && mail.internal.error) console.error('claim: internal mail failed', mail.internal.error);
    const k = await klaviyo.track('Listing Claimed', email, {
      store: rec.storeName, entry_store: id, chain: rec.chain, first_name: name.split(' ')[0] || '',
      logo: !!logoUrl, hours: !!fields.hours, description: !!fields.description, revision: rec.revision,
      pos_url: `${require('../lib/config').SITE_URL}/s/${id}`,
    }).catch(e => ({ error: e.message }));
    if (k && k.error) console.error('claim: klaviyo failed', k.error);
    return res.status(200).json(out);
  } catch (e) {
    console.error('claim: failed', { id, err: e.message });
    return res.status(500).json({ error: 'Something went wrong saving your listing. Please try again.' });
  }
};
