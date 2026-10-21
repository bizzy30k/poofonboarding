// Poof HQ (core) — READ-ONLY lookup of the store ids HQ already has.
//
// Core is the system of record. We never write to it from here; we only ask it which `id` belongs to
// each AGCO location so that the same id travels with the retailer everywhere Poof-side:
//   - claim records + the internal "listing claimed" email + /admin  → rec.hq { id, slug, url }
//   - Stripe customer metadata                                        → hq_<CRSA> = https://hq.poof.ca/store/<id>
//   - Klaviyo event props                                             → hq_store_id
//
// Source: GET {CORE_API_URL}/admin/store/list-unclaimed?unclaimed=true&count=500&search=<keyword>
// Auth:   CORE_API_KEY, sent as `Authorization: Bearer …` by default. CORE_API_AUTH switches the scheme:
//           bearer (default) | x-api-key | cookie | header:<Name>   (e.g. header:x-admin-token)
// Each core store looks like { id, slug, name, displayAs, licenseNumber: 'CRSA…', location: { address, postalCode, city }, … }.
//
// Matching, per AGCO store: licenseNumber === CRSA (exact) → else same postal code + same street number
// and a name overlap (the 'address' match, flagged so /admin shows it as a guess). Unmatched → null.
// Every call is best-effort: a core outage returns null and the claim/signup proceeds without the id.
const config = require('./config');
const sec = require('./security');

const HQ_STORE_URL = (process.env.HQ_STORE_URL && process.env.HQ_STORE_URL.trim()) || 'https://hq.poof.ca/store/';
const CORE_API_URL = (process.env.CORE_API_URL && process.env.CORE_API_URL.trim() || 'https://core.poof.ca/api/v1').replace(/\/+$/, '');
const TTL = 3600e3;
const searches = new Map(); // keyword → { at, rows }
const byLicence = new Map(); // CRSA → core row (filled from every search)

function enabled() { return !!process.env.CORE_API_KEY; }

function authHeaders() {
  const key = (process.env.CORE_API_KEY || '').trim();
  const mode = (process.env.CORE_API_AUTH || 'bearer').trim().toLowerCase();
  if (mode === 'x-api-key') return { 'x-api-key': key };
  if (mode === 'cookie') return { cookie: key };
  if (mode.startsWith('header:')) return { [mode.slice(7)]: key };
  return { authorization: /^bearer /i.test(key) ? key : `Bearer ${key}` };
}

/** Rows out of whatever envelope core uses: a bare array, or { data | stores | items | results | docs: [] }. */
function rowsOf(j) {
  if (Array.isArray(j)) return j;
  if (!j || typeof j !== 'object') return [];
  for (const k of ['data', 'stores', 'items', 'results', 'docs', 'list']) {
    if (Array.isArray(j[k])) return j[k];
    if (j[k] && typeof j[k] === 'object') { const r = rowsOf(j[k]); if (r.length) return r; }
  }
  return [];
}

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const postal = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const streetNo = (s) => (String(s || '').match(/\d+/) || [''])[0];
const idOf = (row) => String(row.id || row._id || (row._id && row._id.$oid) || '').trim();

/** Shape one core row into what we store. */
function pick(row, matched) {
  const id = idOf(row);
  if (!id) return null;
  return { id, slug: row.slug || null, name: row.displayAs || row.name || null, url: HQ_STORE_URL + id, matched, owner: row.owner ? 'has owner' : null, validated: !!row.isValidated };
}

/** One core search, cached an hour per keyword. Returns [] on any failure. */
async function search(keyword) {
  if (!enabled()) return [];
  const k = norm(keyword).slice(0, 60);
  if (k.length < 2) return [];
  const hit = searches.get(k);
  if (hit && Date.now() - hit.at < TTL) return hit.rows;
  if (!sec.rateLimit('hq:global', 60, 60e3)) return hit ? hit.rows : [];
  try {
    const r = await sec.fetchT(`${CORE_API_URL}/admin/store/list-unclaimed?unclaimed=true&count=500&search=${encodeURIComponent(k)}`, { headers: { accept: 'application/json', ...authHeaders() } }, 6000);
    if (!r.ok) { console.error('hq: search failed', { k, status: r.status }); return hit ? hit.rows : []; }
    const rows = rowsOf(await r.json()).filter(x => x && typeof x === 'object');
    searches.set(k, { at: Date.now(), rows });
    for (const row of rows) { const lic = postal(row.licenseNumber || (row.license && row.license.licenseNumber)); if (/^CRSA\d{6,8}$/.test(lic)) byLicence.set(lic, row); }
    return rows;
  } catch (e) { console.error('hq: search error', { k, err: e.message }); return hit ? hit.rows : []; }
}

/** Match one AGCO store against core rows. */
function matchIn(rows, store) {
  const lic = rows.find(r => postal(r.licenseNumber || (r.license && r.license.licenseNumber)) === store.id);
  if (lic) return pick(lic, 'licence');
  const pc = postal(store.postal), no = streetNo(store.addr);
  const names = [norm(store.chainName), norm(store.name)].filter(Boolean);
  const cand = rows.filter(r => {
    const loc = r.location || {};
    if (!pc || postal(loc.postalCode) !== pc) return false;
    if (no && streetNo(loc.address) && streetNo(loc.address) !== no) return false;
    const rn = norm(r.displayAs || r.name);
    return names.some(n => n && (rn.includes(n) || n.includes(rn)) );
  });
  return cand.length === 1 ? pick(cand[0], 'address') : null;
}

/**
 * HQ record for one AGCO store ({ id, name, addr, city, postal, chainName }) or null.
 * Searches by chain name (one call per chain, cached), then by the store's own name if that misses.
 */
async function match(store) {
  if (!enabled() || !store) return null;
  const cached = byLicence.get(store.id);
  if (cached) return pick(cached, 'licence');
  const keywords = [...new Set([store.chainName, store.name].map(x => norm(x)).filter(x => x.length >= 2))];
  for (const k of keywords) {
    const m = matchIn(await search(k), store);
    if (m) return m;
  }
  return null;
}

/** { CRSA → hq | null } for a list of AGCO stores (same-chain stores share one search). */
async function matchAll(list) {
  const out = {};
  for (const s of list) out[s.id] = await match(s); // sequential: searches are cached, so one chain = one request
  return out;
}

/** Stripe metadata keys: hq_<CRSA> = HQ url per location (≤ max keys) + hq_store_ids summary. */
function stripeMeta(map, max = 10) {
  const meta = {};
  const ids = [];
  let n = 0;
  for (const [crsa, h] of Object.entries(map || {})) {
    if (!h) continue;
    ids.push(`${crsa}=${h.id}`);
    if (n++ < max) meta[`hq_${crsa}`] = h.url;
  }
  meta.hq_store_ids = ids.join(' ').slice(0, 500);
  return meta;
}

/** For tests and local runs. */
function _reset() { searches.clear(); byLicence.clear(); }

module.exports = { enabled, search, match, matchAll, matchIn, stripeMeta, rowsOf, HQ_STORE_URL, _reset };
