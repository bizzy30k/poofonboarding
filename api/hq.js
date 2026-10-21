// GET /api/hq?q=<keyword>        → what core returns for that search, trimmed to the fields we match on
// GET /api/hq?store=CRSA…        → the HQ match for one AGCO store (what a claim/signup would record)
// Diagnostic for the read-only Poof HQ lookup (lib/hq.js). Public store directory data only; rate-limited.
const sec = require('../lib/security');
const stores = require('../lib/stores');
const hq = require('../lib/hq');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!sec.rateLimit(`hq:diag:${sec.clientIp(req)}`, 30, 60e3)) return sec.tooMany(res);
  const q = req.query || {};
  if (q.store) {
    const s = stores.store(String(q.store).toUpperCase().replace(/[^A-Z0-9]/g, ''));
    if (!s) return res.status(404).json({ error: 'No such store.' });
    return res.status(200).json({ store: { id: s.id, name: s.name, chainName: s.chainName, addr: s.addr, city: s.city, postal: s.postal }, hq: await hq.match(s) });
  }
  const kw = String(q.q || '').slice(0, 80);
  if (kw.length < 2) return res.status(400).json({ error: 'Pass ?q= or ?store=' });
  const rows = await hq.search(kw);
  return res.status(200).json({
    enabled: hq.enabled(), core: hq.url, q: kw, count: rows.length, lastError: hq.lastError(),
    rows: rows.slice(0, 50).map(r => ({ id: r.id || r._id, slug: r.slug, name: r.displayAs || r.name, licenseNumber: r.licenseNumber || (r.license && r.license.licenseNumber) || null, address: r.location ? `${r.location.address}, ${r.location.city} ${r.location.postalCode}` : null, owner: r.owner || null, isValidated: !!r.isValidated })),
  });
};
