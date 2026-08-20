#!/usr/bin/env node
/**
 * build-index.mjs — turns the AGCO "Cannabis Store Applications" export into
 * the retailer index the onboarding flow searches.
 *
 *   node scripts/build-index.mjs \
 *     --agco data/Cannabis-Store-Applications-20260814-EN.csv \
 *     --pos  data/poof-pos-index.json \
 *     --out  data/retailers.json
 *
 * The AGCO export is authoritative for licence, legal address and status, but
 * it is not clean:
 *   - Store names arrive in three casings ("FIKA CANNABIS" / "FIKA Cannabis" / "Fika Cannabis")
 *   - Curly and straight apostrophes both appear ("POP’S" / "POP'S")
 *   - City names are baked into store names ("Pop's Cannabis Co. Courtice")
 *   - The same banner appears under name variants ("The Hunny Pot Cannabis Co." / "Hunny Pot Cannabis")
 *   - Some rows are exact duplicates under one licence number
 *   - 89 rows carry no licence number at all
 *
 * All of that is resolved here, once, at build time — not on every keystroke
 * in the typeahead.
 *
 * The --pos file is your own integration list, keyed by licence number:
 *   [{ "licenceNumber": "CRSA1188757", "pos": "greenline", "integrated": true }, ...]
 * Anything it matches gets a verified POS badge in the flow.
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveCoords } from '../lib/geo.js';

/* ---------------- args ---------------- */

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]]);
    return acc;
  }, [])
);

const AGCO = args.agco || 'data/Cannabis-Store-Applications-20260814-EN.csv';
const POS = args.pos || 'data/poof-pos-index.json';
const OUT = args.out || 'data/retailers.json';

/* ---------------- csv ---------------- */

/** RFC-4180 parser. Small enough file that a hand-rolled one beats a dependency. */
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else quoted = false;
      } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }

  const header = rows.shift().map(h => h.replace(/^\uFEFF/, '').trim());
  return rows
    .filter(r => r.some(v => v.trim()))
    .map(r => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}

/* ---------------- name cleaning ---------------- */

const LOWER_WORDS = new Set(['and', 'of', 'the', 'at', 'on', 'in', 'a', 'for']);
const KEEP_UPPER = new Set(['THC', 'CBD', 'BC', 'GTA', 'KW', 'OG', 'NYC', 'MJ', 'XO']);

/** "FIKA LOCAL CANNABIS" and "fika local cannabis" both become "Fika Local Cannabis". */
function titleCase(s) {
  return s
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .split(/\s+/)
    .map((w, i) => {
      const bare = w.replace(/[^A-Za-z]/g, '');
      if (KEEP_UPPER.has(bare.toUpperCase()) && bare.length <= 4 && w === w.toUpperCase()) return w;
      if (i > 0 && LOWER_WORDS.has(w.toLowerCase())) return w.toLowerCase();
      // Preserve deliberate internal caps like "MedCan", but fix full-caps shouting.
      if (/[a-z]/.test(w) && /[A-Z]/.test(w.slice(1))) return w;
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    })
    .join(' ')
    .replace(/\bCo\b\.?/g, 'Co.')
    .trim();
}

const BANNER_NOISE = new Set([
  'the', 'cannabis', 'co', 'company', 'inc', 'ltd', 'corp', 'store', 'shop',
  'dispensary', 'weed', 'retail'
]);

function normalizeKey(s = '') {
  return s.toLowerCase()
    .replace(/[\u2018\u2019']/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Derives the banner a store belongs to.
 * Strips filler words and any trailing token that just repeats the city,
 * so "Pop's Cannabis Co. Courtice" in COURTICE lands on the same key as
 * "Pop's Cannabis Co." in Barrie.
 */
function bannerKey(storeName, city) {
  const cityTokens = new Set(normalizeKey(city).split(' ').filter(Boolean));
  const tokens = normalizeKey(storeName).split(' ').filter(Boolean);

  // Drop city tokens only from the tail — "Toronto Cannabis Co" keeps its name.
  while (tokens.length > 1 && cityTokens.has(tokens[tokens.length - 1])) tokens.pop();

  const core = tokens.filter(t => !BANNER_NOISE.has(t));
  const key = (core.length ? core : tokens).join(' ');
  return key || normalizeKey(storeName);
}

/* ---------------- status ---------------- */

function classifyStatus(raw) {
  const s = (raw || '').toLowerCase();
  if (s.startsWith('authorized')) return 'authorized';
  if (s.startsWith('cancelled') || s.startsWith('canceled')) return 'cancelled';
  if (s.startsWith('public notice')) return 'public_notice';
  if (s.startsWith('in progress')) return 'in_progress';
  return 'unknown';
}

function cleanUrl(u) {
  if (!u) return null;
  let s = u.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try { return new URL(s).toString().replace(/\/$/, ''); } catch { return null; }
}

const slug = s => normalizeKey(s).replace(/\s+/g, '-').slice(0, 60);

/* ---------------- build ---------------- */

const csvText = fs.readFileSync(path.resolve(AGCO), 'utf8');
const raw = parseCsv(csvText);

let posIndex = [];
try {
  posIndex = JSON.parse(fs.readFileSync(path.resolve(POS), 'utf8'));
} catch {
  console.warn(`[build] no POS index at ${POS} — nothing will be marked verified.`);
}
const posByLicence = new Map(
  posIndex.filter(p => p.licenceNumber).map(p => [p.licenceNumber.trim().toUpperCase(), p])
);

const seen = new Set();
const stores = [];
const stats = { rows: raw.length, duplicates: 0, noLicence: 0, byStatus: {} };

for (const r of raw) {
  const storeName = (r['Store Name'] || '').trim();
  const city = (r['City or Town'] || '').trim();
  const address = (r['Address'] || '').trim();
  if (!storeName || !address) continue;

  const licence = (r['License Number'] || '').trim().toUpperCase() || null;
  if (!licence) stats.noLicence++;

  // Exact duplicates share licence + address; keep the first.
  const dedupeKey = `${licence || 'NOLIC'}|${normalizeKey(address)}|${normalizeKey(city)}`;
  if (seen.has(dedupeKey)) { stats.duplicates++; continue; }
  seen.add(dedupeKey);

  const status = classifyStatus(r['Store Application Status']);
  stats.byStatus[status] = (stats.byStatus[status] || 0) + 1;

  const key = bannerKey(storeName, city);
  const pos = licence ? posByLicence.get(licence) : null;

  stores.push({
    id: licence ? `${licence}-${slug(city)}` : `nolic-${slug(storeName)}-${slug(address)}`,
    licenceNumber: licence,
    bannerId: slug(key),
    bannerKey: key,
    name: titleCase(storeName),
    rawName: storeName,
    status,
    statusLabel: r['Store Application Status'] || null,
    website: cleanUrl(r['Website URL']),
    address: {
      street: titleCase(address),
      city: titleCase(city),
      province: 'ON',
      postal: (r['Postal Code'] || '').trim().toUpperCase().replace(/^(\w{3})(\w{3})$/, '$1 $2')
    },
    pos: pos?.pos || null,
    integrated: !!pos?.integrated
  });

  // Coordinates for the coverage map. City-level, not street-level — see lib/geo.js.
  const last = stores[stores.length - 1];
  const c = resolveCoords(last);
  last.lat = Number(c.lat.toFixed(4));
  last.lng = Number(c.lng.toFixed(4));
  last.geo = c.precision;
}

/* --- canonical banner label: the most common cleaned name in the group --- */

const groups = new Map();
for (const s of stores) {
  if (!groups.has(s.bannerId)) groups.set(s.bannerId, []);
  groups.get(s.bannerId).push(s);
}

for (const [, members] of groups) {
  const counts = new Map();
  for (const m of members) {
    // "Highlife Ancaster" in Ancaster is a location label, not a banner label.
    // Strip the trailing city before voting, or every chain named after its
    // town elects an arbitrary branch as the banner.
    const cityTokens = new Set(normalizeKey(m.address.city).split(' ').filter(Boolean));
    const words = m.name.split(/\s+/);
    while (words.length > 1 && cityTokens.has(normalizeKey(words[words.length - 1]))) words.pop();
    const label = words.join(' ').replace(/[\s\-–—,]+$/, '').trim() || m.name;
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  const banner = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0][0];
  for (const m of members) m.banner = banner;
}

/* ---------------- write ---------------- */

fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
fs.writeFileSync(path.resolve(OUT), JSON.stringify(stores));

const authorized = stores.filter(s => s.status === 'authorized');
const multi = [...groups.values()].filter(g => g.length > 1);

console.log(`
  AGCO rows read        ${stats.rows}
  exact duplicates      ${stats.duplicates} (dropped)
  missing licence       ${stats.noLicence}
  stores written        ${stores.length}

  authorized            ${stats.byStatus.authorized || 0}
  cancelled             ${stats.byStatus.cancelled || 0}
  in progress           ${stats.byStatus.in_progress || 0}
  public notice         ${stats.byStatus.public_notice || 0}

  banners               ${groups.size}  (${multi.length} multi-location)
  with a website        ${authorized.filter(s => s.website).length} of ${authorized.length} authorized
  POS-verified          ${stores.filter(s => s.integrated).length}
  mapped by city        ${stores.filter(s => s.geo === 'city').length}
  mapped by region      ${stores.filter(s => s.geo === 'region').length}

  → ${OUT}
`);
