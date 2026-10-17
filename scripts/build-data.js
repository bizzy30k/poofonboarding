#!/usr/bin/env node
/**
 * Builds data/stores.json from data/agco.json.
 *
 * agco.json comes from the AGCO Cannabis Retail Store register, filtered to
 * stores with status "Authorized to Open". Shape (same as join.poof.ca):
 *   { b: [[bannerName, slug, count], ...],
 *     s: [[crsa, rawName, address, city, postal, lat, lng, bannerIdx], ...] }
 *
 * This script does the chain roll-up properly: "Sessions Cannabis - Kenora",
 * "SESSIONS CANNABIS NORTH YORK" and "Sessions Cannabis-Waterloo" all land
 * under one chain, "Sessions Cannabis", with the raw AGCO name kept on the
 * location row.
 *
 * To refresh: download the register CSV from agco.ca, run scripts/import-agco.js
 * (which writes agco.json), then run this.
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'data', 'agco.json');
const OUT = path.join(__dirname, '..', 'data', 'stores.json');

const P = JSON.parse(fs.readFileSync(SRC, 'utf8'));

// Words that are never part of a chain's name, only of a location's.
const STOP = new Set(['inc', 'inc.', 'ltd', 'ltd.', 'co', 'co.', 'corp', 'corp.', 'retail', 'store', 'shop',
  'the', 'and', '&', 'cannabis', 'cannabis.', 'dispensary', 'company']);

// Hand aliases for AGCO naming drift inside one operator. Key = chain key
// after normalisation, value = the key to fold into.
const ALIASES = {
  'hunny pot cannabis': 'the hunny pot cannabis co',
  'one plant cannabis superstore': 'one plant',
  'fika local cannabis': 'fika cannabis',
  'fika local fairview mall': 'fika cannabis',
  'fika local fairview park': 'fika cannabis',
  'fika canary': 'fika cannabis',
  'fika distillery': 'fika cannabis',
};

function titleCase(s) {
  return s.toLowerCase().replace(/(^|[\s\-(])([a-z])/g, (m, p, c) => p + c.toUpperCase())
    .replace(/\bOf\b/g, 'of').replace(/\bAnd\b/g, 'and').replace(/\bThe\b/g, (m, o) => o === 0 ? 'The' : 'the');
}

// Reduce a raw AGCO name to a chain key. Order matters.
function chainKey(raw, city) {
  let s = raw.trim();
  s = s.replace(/\s+/g, ' ');
  // Drop anything after a dash/em-dash/pipe/colon: "Sessions Cannabis - Kenora"
  s = s.replace(/\s*[-–—|:]\s*.*$/, '');
  // Drop parentheticals: "Kitchener (Stanley Park)"
  s = s.replace(/\s*\(.*?\)\s*/g, ' ');
  // Drop a trailing "#12" or "Unit 4" style suffix
  s = s.replace(/\s+#?\d+[A-Za-z]?$/, '');
  // Drop a trailing city name (exact token match on the AGCO city)
  if (city) {
    const c = city.toLowerCase().replace(/[^a-z ]/g, '');
    const re = new RegExp('\\s+' + c.replace(/\s+/g, '\\s+') + '$', 'i');
    s = s.replace(re, '');
    // "Sessions Cannabis North York" where city = Toronto — also strip known
    // neighbourhood-ish trailing proper nouns if the remaining head matches
    // a known chain head (handled by the second pass below).
  }
  s = s.replace(/[.,'’]/g, '').trim();
  return s.toLowerCase();
}

// Pass 1: naive keys
const stores = P.s.map(r => ({
  id: r[0], raw: r[1], addr: r[2], city: r[3], postal: r[4], lat: r[5], lng: r[6], website: r[8] || '',
  key: chainKey(r[1], r[3])
}));

// Pass 2: for keys that are a known multi-store head plus extra trailing words,
// collapse onto the head. E.g. "sessions cannabis north york" → "sessions cannabis".
const counts = {};
stores.forEach(s => { counts[s.key] = (counts[s.key] || 0) + 1; });
// A head must be specific: two+ words, or one word of 6+ letters that isn't filler ("cannabis" alone is not a chain).
const specific = k => { const w = k.split(' '); return w.length >= 2 || (k.length >= 6 && !STOP.has(k)); };
const heads = Object.keys(counts).filter(k => counts[k] >= 2 && specific(k)).sort((a, b) => b.length - a.length);
stores.forEach(s => {
  if (counts[s.key] >= 2) return;
  for (const h of heads) {
    if (s.key.startsWith(h + ' ')) { s.key = h; return; }
  }
  // Also try the first two words as a head when they form a known head
  const w = s.key.split(' ');
  for (let n = w.length - 1; n >= 2; n--) {
    const cand = w.slice(0, n).join(' ');
    if (cand !== s.key && heads.includes(cand)) { s.key = cand; return; }
  }
});

stores.forEach(s => { if (ALIASES[s.key]) s.key = ALIASES[s.key]; });

// Pass 3: fold naming drift inside one operator — "Highlife" vs "Highlife
// Cannabis", "The Hunny Pot Cannabis Co" vs "Hunny Pot". Two keys merge when
// they share a root (leading "the" and trailing filler words removed), the
// root is specific enough (two words, or one word of 6+ letters), and at
// least one side is already a multi-store chain. Singletons never merge with
// each other, so "Toke" and "Toke Cannabis" stay separate operators.
function root(key) {
  let w = key.split(' ');
  if (w[0] === 'the' && w.length > 1) w = w.slice(1);
  while (w.length > 1 && STOP.has(w[w.length - 1])) w.pop();
  return w.join(' ');
}
stores.forEach(s => { s.head = s.key; });
{
  const cnt = {}; stores.forEach(s => { cnt[s.key] = (cnt[s.key] || 0) + 1; });
  const byRoot = {};
  Object.keys(cnt).forEach(k => { const r = root(k); (byRoot[r] = byRoot[r] || []).push(k); });
  const fold = {};
  Object.entries(byRoot).forEach(([r, keys]) => {
    if (keys.length < 2) return;
    const words = r.split(' ');
    if (words.length === 1 && (r.length < 6 || STOP.has(r))) return;
    const target = keys.sort((a, b) => cnt[b] - cnt[a] || a.length - b.length)[0];
    if (cnt[target] < 2) return;
    keys.forEach(k => { if (k !== target) fold[k] = target; });
  });
  stores.forEach(s => { if (fold[s.key]) s.key = fold[s.key]; });
}

// Assemble chains
const chains = {};
stores.forEach(s => {
  if (!chains[s.key]) chains[s.key] = { key: s.key, names: {}, heads: {}, stores: [] };
  chains[s.key].stores.push(s);
  chains[s.key].heads[s.head] = (chains[s.key].heads[s.head] || 0) + 1;
  // Display name: most common title-cased head among its stores
  const disp = titleCase(s.raw.replace(/\s*[-–—|:]\s*.*$/, '').replace(/\s*\(.*?\)\s*/g, ' ').trim());
  chains[s.key].names[disp] = (chains[s.key].names[disp] || 0) + 1;
});

const out = Object.values(chains).map(c => {
  // Prefer the shortest of the most frequent display names
  const top = Object.entries(c.names).sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0];
  // If no single display name repeats, every store is named differently
  // ("Highlife Ancaster", "Highlife Deep River"…) — name the chain after the
  // most common head instead of whichever location happened to sort first.
  const head = Object.entries(c.heads).sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0][0];
  const headDisp = Object.keys(c.names).find(n => n.toLowerCase().replace(/[.,'’]/g, '').replace(/\s+/g, ' ').trim() === head);
  const best = top[1] >= 2 || c.stores.length < 2 || STOP.has(head) ? top[0] : (headDisp || titleCase(head));
  const slug = c.key.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return {
    slug,
    name: best,
    count: c.stores.length,
    stores: c.stores
      .sort((a, b) => a.city.localeCompare(b.city) || a.raw.localeCompare(b.raw))
      .map(s => ({ id: s.id, name: s.raw, addr: s.addr, city: s.city, postal: s.postal, lat: s.lat, lng: s.lng, ...(s.website ? { website: s.website } : {}) }))
  };
}).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

fs.writeFileSync(OUT, JSON.stringify({ built: new Date().toISOString().slice(0, 10), status: 'Authorized to Open', chains: out }));

const total = out.reduce((n, c) => n + c.count, 0);
console.log(`stores.json: ${out.length} chains, ${total} authorized stores`);
for (const q of ['sessions', 'we store', 'fika', "pop's", 'value buds', 'canna cabana', 'hunny pot', 'one plant']) {
  const m = out.filter(c => c.name.toLowerCase().includes(q));
  console.log(`  ${q.padEnd(12)} → ${m.map(c => `${c.name} (${c.count})`).join(', ')}`);
}
