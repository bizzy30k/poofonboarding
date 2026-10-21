// GET /api/photo?store=CRSA… — the store's Google Business photo, proxied (the Places key never reaches the browser).
// Used as the preview for "Use my Google photo" on the claim form. 404 when Google has none.
const sec = require('../lib/security');
const stores = require('../lib/stores');
const { photo } = require('../lib/places');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!sec.rateLimit(`photo:${sec.clientIp(req)}`, 30, 60e3)) return sec.tooMany(res);
  const id = String((req.query || {}).store || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const s = /^CRSA\d{6,8}$/.test(id) ? stores.store(id) : null;
  if (!s) return res.status(404).json({ error: 'No such store.' });
  const p = await photo(s);
  if (!p) return res.status(404).json({ error: 'No photo.' });
  res.setHeader('Cache-Control', 'public, max-age=21600');
  res.setHeader('Content-Type', p.type);
  return res.status(200).send(p.buf);
};
