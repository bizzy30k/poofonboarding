// GET /api/links?key=<ADMIN_KEY>            → CSV of every store with its personal link
// GET /api/links?key=<ADMIN_KEY>&q=sessions → just the stores matching a name/city
const config = require('../lib/config');
const stores = require('../lib/stores');

module.exports = async (req, res) => {
  const { key, q } = req.query || {};
  if (!config.ADMIN_KEY || key !== config.ADMIN_KEY) return res.status(401).send('Unauthorized');
  const db = stores.load();
  const needle = (q || '').toLowerCase();
  const rows = [['chain', 'store_name', 'crsa', 'address', 'city', 'postal', 'chain_doors', 'link']];
  for (const c of db.chains) for (const s of c.stores) {
    if (needle && !(c.name.toLowerCase().includes(needle) || s.name.toLowerCase().includes(needle) || s.city.toLowerCase().includes(needle))) continue;
    rows.push([c.name, s.name, s.id, s.addr, s.city, s.postal, c.count, `${config.SITE_URL}/s/${s.id}`]);
  }
  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="poof-store-links${needle ? '-' + needle.replace(/[^a-z0-9]+/g, '-') : ''}.csv"`);
  return res.status(200).send(csv);
};
