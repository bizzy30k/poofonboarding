// AGCO store index. Loaded once per lambda instance.
const fs = require('fs');
const path = require('path');

let DB = null;
function load() {
  if (DB) return DB;
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'stores.json'), 'utf8'));
  const chains = raw.chains;
  const bySlug = {};
  const byStore = {};
  chains.forEach(c => {
    bySlug[c.slug] = c;
    c.stores.forEach(s => { byStore[s.id] = { ...s, chain: c.slug, chainName: c.name }; });
  });
  DB = { built: raw.built, status: raw.status, chains, bySlug, byStore };
  return DB;
}

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Search chains by name, city, street address, postal code or CRSA number.
 * Returns up to `limit` chains, each with `hit` describing why it matched.
 */
function search(q, limit = 12) {
  const db = load();
  const query = norm(q);
  if (query.length < 2) return [];
  const crsa = /^crsa\s*\d+$/.test(query) ? query.replace(/\s+/g, '').toUpperCase() : null;
  const postal = query.replace(/\s/g, '').toUpperCase();
  const isPostal = /^[A-Z]\d[A-Z]\d?[A-Z]?\d?$/.test(postal);

  const scored = [];
  for (const c of db.chains) {
    const name = norm(c.name);
    let score = 0, hit = null;
    if (name === query) { score = 100; hit = 'name'; }
    else if (name.startsWith(query)) { score = 80; hit = 'name'; }
    else if (name.includes(query)) { score = 60; hit = 'name'; }
    // Store-level matches
    let storeHits = [];
    for (const s of c.stores) {
      if (crsa && s.id === crsa) { score = Math.max(score, 100); hit = 'licence'; storeHits.push(s); continue; }
      if (isPostal && s.postal.replace(/\s/g, '').toUpperCase().startsWith(postal)) { score = Math.max(score, 70); hit = hit || 'postal'; storeHits.push(s); continue; }
      const sn = norm(s.name), sa = norm(s.addr), sc = norm(s.city);
      if (sn.includes(query)) { score = Math.max(score, 55); hit = hit || 'name'; storeHits.push(s); }
      else if (sa.includes(query)) { score = Math.max(score, 50); hit = hit || 'address'; storeHits.push(s); }
      else if (sc === query) { score = Math.max(score, 30); hit = hit || 'city'; storeHits.push(s); }
    }
    if (score) scored.push({ chain: c, score, hit, storeHits });
  }
  scored.sort((a, b) => b.score - a.score || b.chain.count - a.chain.count);
  const row = s => ({ id: s.id, name: s.name, addr: s.addr, city: s.city, postal: s.postal });
  const chains = scored.slice(0, limit).map(r => ({
    slug: r.chain.slug,
    name: r.chain.name,
    count: r.chain.count,
    hit: r.hit,
    // Stores that matched the query themselves (name/address/postal/licence).
    // When the chain matched by name, every store counts.
    ids: (r.hit === 'name' && norm(r.chain.name).includes(query) ? r.chain.stores : r.storeHits).map(s => s.id),
    // A sample of the matched stores so the dropdown can show "Kenora, Oshawa…"
    sample: [...new Set((r.storeHits.length ? r.storeHits : r.chain.stores).map(s => s.city))].slice(0, 3),
  }));
  // Individual locations, for the one-at-a-time list. Chain-name hits first,
  // then store-level hits, capped so the dropdown stays usable.
  const singles = [];
  for (const r of scored) {
    const list = r.storeHits.length ? r.storeHits : r.chain.stores;
    for (const s of list) singles.push({ ...row(s), chain: r.chain.slug, chainName: r.chain.name });
    if (singles.length >= 40) break;
  }
  // "Everything matching" — every location any of the above pulled in.
  const everyIds = new Set(); const names = new Set();
  chains.forEach(c => c.ids.forEach(id => everyIds.add(id)));
  singles.forEach(s => { everyIds.add(s.id); names.add(norm(s.name)); });
  return { chains, stores: singles.slice(0, 40), all: { count: everyIds.size, names: names.size } };
}

function chain(slug) {
  const db = load();
  const c = db.bySlug[slug];
  if (!c) return null;
  return { ...c, status: db.status, built: db.built };
}

function store(id) { return load().byStore[id] || null; }

module.exports = { load, search, chain, store };
