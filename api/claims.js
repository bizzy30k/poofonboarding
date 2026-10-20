// /api/claims — admin only (x-admin-key header). Review and publish listing claims.
//
//   GET  /api/claims              → { claims: [record…] }  newest first, pending and published
//   GET  /api/claims?id=CRSA…     → { claim: record, core: { …core-shaped fields } }
//   POST /api/claims  { action: 'publish', id, url? }
//        Marks the claim published and sends the owner the "it's live — have a look" email.
//        `url` is the listing's marketplace URL; defaults to MARKETPLACE_URL (poof.ca).
//        Call this after the details are in Poof HQ — the email promises the listing is visible.
//   POST /api/claims  { action: 'resend', id }   re-sends the "updated" email (email 1)
//
// Idempotent: publishing twice re-sends the live email but keeps the first publishedAt.
const sec = require('../lib/security');
const config = require('../lib/config');
const claims = require('../lib/claims');
const { sendClaimLiveEmail, sendClaimEmails } = require('../lib/mail');
const klaviyo = require('../lib/klaviyo');

const MARKETPLACE_URL = (process.env.MARKETPLACE_URL && process.env.MARKETPLACE_URL.trim()) || 'https://poof.ca';

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!sec.requireAdmin(req, res)) return;

  try {
    if (req.method === 'GET') {
      const id = String((req.query || {}).id || '').toUpperCase();
      if (id) {
        const rec = await claims.getRecord(id);
        if (!rec) return res.status(404).json({ error: 'No claim for that store.' });
        return res.status(200).json({ claim: rec, core: claims.toCoreListing(rec) });
      }
      return res.status(200).json({ claims: await claims.listRecords() });
    }

    if (req.method === 'POST') {
      const b = sec.body(req);
      if (!b) return res.status(400).json({ error: 'Bad request.' });
      const id = String(b.id || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const rec = /^CRSA\d{6,8}$/.test(id) ? await claims.getRecord(id) : null;
      if (!rec) return res.status(404).json({ error: 'No claim for that store.' });

      if (b.action === 'publish') {
        const url = claims.v.website(b.url) || rec.liveUrl || MARKETPLACE_URL;
        if (url === undefined) return res.status(400).json({ error: 'url must be an http(s) URL.' });
        rec.status = 'published';
        rec.publishedAt = rec.publishedAt || new Date().toISOString();
        rec.liveUrl = url;
        await claims.putRecord(rec);
        const mail = await sendClaimLiveEmail(rec, url).catch(e => ({ error: e.message }));
        const k = await klaviyo.track('Listing Published', rec.contact.email, { store: rec.storeName, entry_store: id, chain: rec.chain, first_name: rec.contact.name.split(' ')[0] || '', live_url: url, pos_url: `${config.SITE_URL}/s/${id}` }).catch(e => ({ error: e.message }));
        return res.status(200).json({ ok: true, id, status: rec.status, publishedAt: rec.publishedAt, liveUrl: url, mail, klaviyo: k });
      }
      if (b.action === 'resend') {
        const mail = await sendClaimEmails(rec, claims.toCoreListing(rec));
        return res.status(200).json({ ok: true, id, mail });
      }
      return res.status(400).json({ error: "action must be 'publish' or 'resend'." });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('claims: failed', e.message);
    return res.status(500).json({ error: e.message });
  }
};
