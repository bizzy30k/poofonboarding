// POST /api/claim-link — "Lost your link?" on the locked claim page.
// Body: { id, email }. Re-sends email 1 (with the edit link) to the claim's contact — only when the email the
// visitor typed is that contact. The reply is the same either way, so it never confirms who claimed a store.
const sec = require('../lib/security');
const claims = require('../lib/claims');
const stores = require('../lib/stores');
const { sendClaimLinkEmail } = require('../lib/mail');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!sec.sameOrigin(req)) return res.status(403).json({ error: 'Forbidden' });
  const ip = sec.clientIp(req);
  if (!sec.rateLimit(`claimlink:ip:${ip}`, 5, 3600e3)) return sec.tooMany(res);
  const b = sec.body(req);
  if (!b) return res.status(400).json({ error: 'Bad request.' });
  const id = String(b.id || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const email = sec.v.email(b.email);
  if (!/^CRSA\d{6,8}$/.test(id) || !email) return res.status(400).json({ error: 'Enter the email you claimed with.' });
  if (!sec.rateLimit(`claimlink:store:${id}`, 3, 3600e3)) return sec.tooMany(res);
  try {
    const rec = await claims.getRecord(id).catch(() => null);
    if (rec && rec.contact && rec.contact.email.toLowerCase() === email.toLowerCase()) {
      const store = stores.store(id);
      const siblings = await claims.unclaimedSiblings(store, stores.chain(store && store.chain));
      const r = await sendClaimLinkEmail(rec, { token: claims.editToken(id, rec.contact.email), siblings: siblings.length });
      if (r && r.error) console.error('claim-link: mail failed', r.error);
    }
  } catch (e) { console.error('claim-link: failed', { id, err: e.message }); }
  return res.status(200).json({ ok: true }); // identical whether or not the email matched
};
