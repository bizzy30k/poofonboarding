// POST /api/claim-bulk — "Claim the rest": after the first location, claim every other unclaimed store on
// the same licence with one click, reusing the logo, website, Instagram and description. Phone and
// hours come from Google Places per store; when Google has nothing we copy the source store's and
// flag it for review in the internal email.
//
// Body:  { from: CRSA (the store just claimed), t: its edit token, ids: [CRSA…] }
// Reply: { ok, claimed: [CRSA…], skipped: [{ id, reason }], token }
//
// Ownership is the edit token from the first claim (the response of POST /api/claim, also in the
// owner's email), so no Turnstile here. Every record gets the same contact and a `copiedFrom`.
const sec = require('../lib/security');
const config = require('../lib/config');
const stores = require('../lib/stores');
const claims = require('../lib/claims');
const { places, hoursFromWeekdayText } = require('../lib/places');
const { sendClaimBulkEmails } = require('../lib/mail');
const klaviyo = require('../lib/klaviyo');

const CRSA = /^CRSA\d{6,8}$/;
const MAX_IDS = 60;
const cleanId = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!sec.sameOrigin(req)) return res.status(403).json({ error: 'Forbidden' });
  const ip = sec.clientIp(req);
  const b = sec.body(req);
  if (!b) return res.status(400).json({ error: 'Bad request.' });

  const from = cleanId(b.from);
  const src = CRSA.test(from) ? await claims.getRecord(from).catch(() => null) : null;
  if (!src) return res.status(404).json({ error: 'Claim the first location before adding the rest.' });
  if (!claims.checkEditToken(src, b.t)) return res.status(403).json({ error: 'Forbidden' });
  if (!sec.rateLimit(`claimbulk:${from}`, 3, 3600e3) || !sec.rateLimit(`claimbulk:ip:${ip}`, 5, 3600e3)) return sec.tooMany(res);

  const ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map(cleanId).filter(x => CRSA.test(x) && x !== from))].slice(0, MAX_IDS);
  if (!ids.length) return res.status(400).json({ error: 'Pick at least one location.' });

  const taken = await claims.claimedIds().catch(() => new Set());
  const claimed = []; const skipped = []; const recs = [];
  const now = new Date().toISOString();
  for (const id of ids) {
    const s = stores.store(id);
    if (!s) { skipped.push({ id, reason: 'no such store' }); continue; }
    if (s.chain !== src.chain) { skipped.push({ id, reason: 'different licence' }); continue; }
    if (taken.has(id)) { skipped.push({ id, reason: 'already claimed' }); continue; }
    const g = await places(s); // cached + capped; null when Google has nothing or the cap is hit
    const phone = claims.v.phone(g && g.phone) || src.listing.phone;
    const hours = hoursFromWeekdayText(g && g.hours) || src.listing.hours;
    const needsReview = [];
    if (!(g && claims.v.phone(g.phone))) needsReview.push('phone copied from ' + from);
    if (!(g && hoursFromWeekdayText(g.hours))) needsReview.push('hours copied from ' + from);
    recs.push({
      id,
      storeName: s.chainName || s.name,
      chain: s.chain,
      location: { name: s.name, addr: s.addr, city: s.city, postal: s.postal },
      status: 'pending',
      revision: 1,
      claimedAt: now,
      submittedAt: now,
      publishedAt: null,
      liveUrl: null,
      contact: src.contact,
      listing: { ...src.listing, phone, hours },
      copiedFrom: from,
      needsReview,
      googlePhone: g && g.phone ? g.phone : null,
      ip,
      source: 'onboarding.poof.ca/claim-bulk',
    });
  }

  try {
    await Promise.all(recs.map(r => claims.putRecord(r)));
    recs.forEach(r => claimed.push(r.id));
    if (recs.length) {
      const mail = await sendClaimBulkEmails(src, recs, { token: String(b.t) });
      if (mail.retailer && mail.retailer.error) console.error('claim-bulk: retailer mail failed', mail.retailer.error);
      if (mail.internal && mail.internal.error) console.error('claim-bulk: internal mail failed', mail.internal.error);
      const k = await klaviyo.track('Listing Claimed', src.contact.email, {
        store: src.storeName, entry_store: from, chain: src.chain, first_name: src.contact.name.split(' ')[0] || '',
        logo: !!src.listing.logoUrl, hours: true, description: !!src.listing.description, revision: 1,
        locations: recs.length, bulk: true, location_ids: claimed.join(','),
        pos_url: `${config.SITE_URL}/s/${from}?also=${claimed.join(',')}`,
      }).catch(e => ({ error: e.message }));
      if (k && k.error) console.error('claim-bulk: klaviyo failed', k.error);
    }
    return res.status(200).json({ ok: true, claimed, skipped, token: String(b.t) });
  } catch (e) {
    console.error('claim-bulk: failed', { from, err: e.message });
    return res.status(500).json({ error: 'Something went wrong saving your locations. Please try again.' });
  }
};
