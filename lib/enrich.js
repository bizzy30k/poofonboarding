/**
 * enrich.js — turns a store name into a confirmable retailer record.
 *
 * Source priority:
 *   1. AGCO index         — licence, legal address, authorization status. Authoritative.
 *                           Built from the AGCO export by scripts/build-index.mjs.
 *   2. Poof POS index     — merged into the AGCO index at build time by licence number.
 *                           This is what turns a POS badge green.
 *   3. Google Places      — hours, phone, website, rating. Anchored on the AGCO street
 *                           address, so the match is near-exact rather than a name guess.
 *   4. Website fingerprint — infers POS / menu / payment stack from the retailer's own site.
 *
 * Nothing here is asserted as fact. Every field carries a `source`, the UI keeps it
 * editable, and detected stack is labelled "detected", never "verified".
 */

import fs from 'node:fs';
import path from 'node:path';

/* ------------------------------------------------------------------ *
 * Index
 * ------------------------------------------------------------------ */

let _index = null;

export function loadIndex() {
  if (_index) return _index;
  const file = process.env.RETAILER_INDEX_PATH
    || path.join(process.cwd(), 'data', 'retailers.json');
  try {
    _index = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error('[enrich] retailer index unavailable:', err.message);
    console.error('[enrich] run: node scripts/build-index.mjs');
    _index = [];
  }
  return _index;
}

/* ------------------------------------------------------------------ *
 * Matching
 * ------------------------------------------------------------------ */

const NOISE = new Set([
  'cannabis', 'co', 'company', 'inc', 'ltd', 'corp', 'the', 'shop', 'store',
  'dispensary', 'weed', 'retail', 'retailer', 'ontario', 'canada'
]);

export function normalize(s = '') {
  return String(s)
    .toLowerCase()
    .replace(/&/g, ' and ')
    // Apostrophes vanish rather than splitting: people type "pops", not "pop s".
    .replace(/['\u2018\u2019]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Content words, with filler like "cannabis" and "inc" stripped. If a name is
 * made *entirely* of filler — there is a store called "Cannabis Cannabis" —
 * fall back to the raw words rather than returning nothing to match on.
 */
const tokens = s => {
  const all = normalize(s).split(' ').filter(Boolean);
  const content = all.filter(t => !NOISE.has(t));
  return content.length ? content : all;
};

/** Cheap edit-distance ratio, 0..1. Good enough for storefront names. */
function similarity(a, b) {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    [prev, curr] = [curr, prev];
  }
  return 1 - prev[n] / Math.max(m, n);
}

export function scoreMatch(query, record) {
  const q = normalize(query);
  const qt = tokens(query);
  const candidates = [record.banner, record.name, record.rawName].filter(Boolean);

  let best = 0;
  for (const c of candidates) {
    const cNorm = normalize(c);
    const ct = tokens(c);

    let s = similarity(q, cNorm) * 0.55;

    // A half-typed token still counts, at a discount — people search mid-word.
    let overlap = 0;
    for (const t of qt) {
      if (ct.includes(t)) { overlap += 1; continue; }
      const partial = ct.some(c2 =>
        (t.length >= 3 && c2.startsWith(t)) ||
        (c2.length >= 3 && t.startsWith(c2)) ||
        similarity(t, c2) > 0.75
      );
      if (partial) overlap += 0.7;
    }
    if (qt.length) s += (overlap / qt.length) * 0.35;

    // Coverage runs both ways. Without this, "fika" scores a one-off
    // "Fika Canary" above the six-store "Fika Cannabis" banner, because the
    // extra token costs nothing. Unmatched candidate tokens should cost.
    if (ct.length) {
      const matchedBack = ct.filter(c2 =>
        qt.includes(c2) || qt.some(t => t.length >= 3 && c2.startsWith(t))
      ).length;
      s -= (1 - matchedBack / ct.length) * 0.12;
    }

    // Prefix bonus has to work mid-string. "hunn" is the start of a token in
    // "The Hunny Pot Cannabis Co." even though the string starts with "the",
    // and without this those records score below threshold while the shorter
    // "Hunny Pot Cannabis" variants pass — same banner, split results.
    if (cNorm.startsWith(q)) s += 0.15;
    else if (ct.some(c2 => c2.startsWith(q)) || cNorm.split(' ').some(w => w.startsWith(q))) s += 0.13;

    best = Math.max(best, Math.min(Math.max(s, 0), 1));
  }
  return best;
}

/* ------------------------------------------------------------------ *
 * Query interpretation
 * ------------------------------------------------------------------ */

/**
 * Street-type abbreviations, so "38 Mill Street East" finds "38 MILL ST E".
 * Expanded to the short form, because that is what the AGCO file uses.
 */
const STREET_ABBR = {
  street: 'st', avenue: 'ave', road: 'rd', drive: 'dr', boulevard: 'blvd',
  crescent: 'cres', court: 'crt', place: 'pl', parkway: 'pkwy', highway: 'hwy',
  lane: 'ln', terrace: 'terr', square: 'sq', trail: 'trl', circle: 'cir',
  east: 'e', west: 'w', north: 'n', south: 's',
  northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw',
  unit: 'unit', suite: 'unit', ste: 'unit', '#': 'unit'
};

function normalizeAddress(s = '') {
  return normalize(s)
    .split(' ')
    .map(w => STREET_ABBR[w] || w)
    .join(' ')
    .trim();
}

const stripPostal = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const stripLicence = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

const RE_LICENCE = /^(crsa)?\s*-?\s*\d{4,}$/i;                 // CRSA1188757, crsa 1188757, 1188757
const RE_POSTAL_FULL = /^[a-z]\d[a-z]\s?\d[a-z]\d$/i;           // L7J 1H2
const RE_POSTAL_FSA = /^[a-z]\d[a-z]$/i;                        // L7J
const RE_STREETISH = /^\d+\s+\S/;                               // "38 Mill"

/** What is the person most likely typing? Used to weight, never to exclude. */
export function classifyQuery(q) {
  const s = String(q || '').trim();
  if (RE_LICENCE.test(s)) return 'licence';
  if (RE_POSTAL_FULL.test(s) || RE_POSTAL_FSA.test(s)) return 'postal';
  if (RE_STREETISH.test(s)) return 'address';
  return 'name';
}

/* ------------------------------------------------------------------ *
 * Per-record scoring across every searchable field
 * ------------------------------------------------------------------ */

/**
 * Scores one record against the query on name, licence, address, postal and
 * city, and reports which field won.
 *
 * `locationSpecific` matters for the UI: a licence number, a street address or
 * a postal code identifies one store, so the flow can preselect it instead of
 * making a 97-location chain pick their own branch out of a list.
 */
export function scoreRecord(query, r, kind = classifyQuery(query)) {
  const q = String(query || '').trim();
  if (!q) return null;

  const qn = normalize(q);
  const best = { score: 0, via: null, locationSpecific: false, label: null };
  const take = (score, via, locationSpecific, label) => {
    if (score > best.score) Object.assign(best, { score, via, locationSpecific, label });
  };

  /* ---- licence number ---- */
  if (r.licenceNumber) {
    const lic = stripLicence(r.licenceNumber);
    const ql = stripLicence(q);
    if (ql.length >= 4) {
      const qDigits = ql.replace(/^CRSA/, '');
      const lDigits = lic.replace(/^CRSA/, '');
      if (lic === ql || lDigits === qDigits) take(1, 'licence', true, r.licenceNumber);
      else if (lDigits.startsWith(qDigits)) take(0.92, 'licence', true, r.licenceNumber);
      else if (lDigits.includes(qDigits) && qDigits.length >= 5) take(0.8, 'licence', true, r.licenceNumber);
    }
  }

  /* ---- postal code ---- */
  if (r.address?.postal) {
    const pc = stripPostal(r.address.postal);
    const qp = stripPostal(q);
    if (qp.length >= 3 && /^[A-Z]\d[A-Z]/.test(qp)) {
      if (pc === qp) take(0.98, 'postal', true, r.address.postal);
      else if (pc.startsWith(qp)) take(qp.length >= 6 ? 0.95 : 0.72, 'postal', qp.length >= 6, r.address.postal);
    }
  }

  /* ---- street address ---- */
  if (r.address?.street) {
    const addr = normalizeAddress(`${r.address.street} ${r.address.city}`);
    const qa = normalizeAddress(q);
    if (qa.length >= 3) {
      const qTokens = qa.split(' ').filter(Boolean);
      const aTokens = addr.split(' ').filter(Boolean);
      const hits = qTokens.filter(tk => aTokens.some(at => at === tk || at.startsWith(tk))).length;
      const cover = hits / qTokens.length;
      if (cover === 1 && qTokens.length >= 2) {
        // A leading street number is a strong signal; two words alone is weaker.
        take(/^\d/.test(qa) ? 0.94 : 0.7, 'address', /^\d/.test(qa), r.address.street);
      } else if (cover >= 0.6 && qTokens.length >= 2) {
        take(0.6 * cover, 'address', false, r.address.street);
      }
    }
  }

  /* ---- city ---- */
  if (r.address?.city) {
    const city = normalize(r.address.city);
    if (qn.length >= 3) {
      if (city === qn) {
        take(0.75, 'city', true, r.address.city);
      } else if (city.startsWith(qn)) {
        // Scaled by coverage, and NOT location-specific — "gan" is a hint, not
        // an identification, so it shouldn't outrank Ganjika House on name.
        take(0.3 + 0.25 * (qn.length / city.length), 'city', false, r.address.city);
      }
    }
  }

  /* ---- name ---- */
  const nameScore = scoreMatch(q, r);
  if (nameScore > 0) take(nameScore, 'name', false, r.banner || r.name);

  /* ---- full store name, e.g. "tokyo smoke rymal" ---- */
  if (r.rawName) {
    const rn = normalize(r.rawName);
    const bannerNorm = normalize(r.banner || '');
    // Skip when the query is nothing but filler words — otherwise a search for
    // "Cannabis Cannabis" branch-matches every store with "cannabis" in its name.
    const qHasContent = qn.split(' ').some(w => w && !NOISE.has(w));
    if (qn.length >= 4 && qHasContent && rn !== bannerNorm) {
      const rnTokens = rn.split(' ').filter(Boolean);
      const qTokens = qn.split(' ').filter(Boolean);
      // Token subset, not substring — "sessions sarnia" has "cannabis" between
      // the two words in "SESSIONS CANNABIS SARNIA".
      const allPresent = qTokens.every(w => rnTokens.some(rt => rt === w || rt.startsWith(w)));
      if (allPresent) {
        // A specific store only if they typed something beyond the banner:
        // "sessions sarnia" names a branch, plain "sessions" does not.
        const bannerTokens = new Set(bannerNorm.split(' '));
        const addsQualifier = qTokens.some(w => !bannerTokens.has(w)
          && ![...bannerTokens].some(bt => bt.startsWith(w)));
        take(addsQualifier ? 0.9 : 0.72, 'name', addsQualifier, r.name);
      }
    }
  }

  // Weight toward whatever the query looks like, so a bare number doesn't get
  // out-ranked by a coincidental name match.
  if (kind !== 'name' && best.via === kind) best.score = Math.min(best.score * 1.15, 1);

  return best.score > 0 ? best : null;
}

/**
 * Typeahead. Groups locations under their banner so a 97-store chain surfaces
 * once with a location count, not 97 near-identical rows — unless the query
 * identified a specific store, in which case that store is carried through so
 * the flow can preselect it.
 *
 * Cancelled stores stay searchable but rank last and carry a flag: someone
 * whose licence lapsed should be told that, not silently find nothing.
 */
export function searchIndex(query, { limit = 8, excludeIds = null } = {}) {
  const q = String(query || '').trim();
  if (q.length < 2) return [];

  const kind = classifyQuery(q);
  const index = loadIndex();
  const threshold = kind === 'name' ? 0.3 : 0.45;

  const byBanner = new Map();

  for (const r of index) {
    const m = scoreRecord(q, r, kind);
    if (!m || m.score <= threshold) continue;

    if (!byBanner.has(r.bannerId)) {
      byBanner.set(r.bannerId, { score: 0, records: [], hits: [], via: null, label: null, cityHits: 0 });
    }
    const g = byBanner.get(r.bannerId);
    g.records.push(r);
    if (m.via === 'city') g.cityHits++;
    if (m.locationSpecific) g.hits.push({ record: r, ...m });
    if (m.score > g.score) Object.assign(g, { score: m.score, via: m.via, label: m.label });
  }

  // Always expand to the banner's full location set. Only some name variants
  // clear the threshold ("Hunny Pot Cannabis" does, "The Hunny Pot Cannabis Co."
  // scores lower), so without this the count reported is the number of rows that
  // happened to match rather than the number of stores the retailer runs.
  for (const [bannerId, g] of byBanner) {
    const all = index.filter(x => x.bannerId === bannerId);
    if (all.length > g.records.length) g.records = all;

    // Drop stores the retailer has already added. A banner with nothing left
    // disappears from the results entirely rather than being offered and then
    // silently ignored on selection.
    if (excludeIds && excludeIds.size) {
      const before = g.records.length;
      g.records = g.records.filter(r => !excludeIds.has(r.id));
      g.alreadyAdded = before - g.records.length;
      g.hits = g.hits.filter(h => !excludeIds.has(h.record.id));
    }
  }

  if (excludeIds && excludeIds.size) {
    for (const [bannerId, g] of [...byBanner]) {
      if (!g.records.length) byBanner.delete(bannerId);
    }
  }

  return [...byBanner.entries()]
    .map(([bannerId, g]) => {
      const open = g.records.filter(r => r.status === 'authorized');
      const pending = g.records.filter(r => r.status === 'in_progress' || r.status === 'public_notice');
      const live = open.length ? open : pending.length ? pending : g.records;
      const cities = [...new Set(live.map(r => r.address.city))];

      // Deduplicate location-specific hits, capped so the payload stays small.
      const seen = new Set();
      const matched = g.hits
        .sort((a, b) => b.score - a.score)
        .filter(h => !seen.has(h.record.id) && seen.add(h.record.id))
        .slice(0, 5)
        .map(h => ({
          id: h.record.id,
          city: h.record.address.city,
          address: [h.record.address.street, h.record.address.city, h.record.address.postal]
            .filter(Boolean).join(', '),
          licenceNumber: h.record.licenceNumber,
          status: h.record.status
        }));

      return {
        bannerId,
        name: g.records[0].banner,
        locationCount: live.length,
        authorizedCount: open.length,
        pendingCount: pending.length,
        allCancelled: open.length === 0 && pending.length === 0,
        city: cities.length === 1 ? cities[0] : null,
        cityCount: cities.length,
        integrated: live.some(r => r.integrated),
        alreadyAdded: g.alreadyAdded || 0,
        matchedVia: g.via,
        matchedLabel: g.label,
        matchedLocations: matched,
        // Size boost normally, but a city search should favour who actually has
        // the most stores there, not who has the most stores overall.
        rank: g.score
          + (open.length ? 0.5 : pending.length ? 0.2 : 0)
          + (matched.length ? 0.3 : 0)
          + (g.via === 'city'
              ? Math.min(g.cityHits * 0.06, 0.3)
              : Math.min(Math.log10(1 + live.length) * 0.12, 0.25)),
        cityMatches: g.via === 'city' ? g.cityHits : 0,
        confidence: Number(g.score.toFixed(2))
      };
    })
    .sort((a, b) => b.rank - a.rank)
    .slice(0, limit)
    .map(({ rank, ...rest }) => rest);
}

/**
 * Sibling banners — other banners that look like the same business.
 *
 * Grouping strips a trailing *city* name, so "Highlife Ancaster" in Ancaster
 * collapses correctly. It can't catch a store named after a neighbourhood,
 * street or mall: Kindling Cannabis ends up as nine banners because Mountainside,
 * Meadowvale and Dundas aren't city names. Rather than guess and merge them —
 * many of these really are separate franchisees — we surface them and let the
 * retailer say which are theirs.
 */
export function relatedBanners(bannerId, { limit = 12 } = {}) {
  const index = loadIndex();
  const seed = index.find(r => r.bannerId === bannerId);
  if (!seed) return [];

  const seedNorm = normalize(seed.banner);
  const seedTokens = tokens(seed.banner);
  if (!seedNorm || !seedTokens.length) return [];

  // A name made entirely of filler — there is a store called "Cannabis Cannabis" —
  // has no distinctive word to match on, so it would sibling itself to every shop
  // with "cannabis" in the name. No suggestions for those.
  const seedHasContent = normalize(seed.banner).split(' ').some(w => w && !NOISE.has(w));
  if (!seedHasContent) return [];

  /**
   * A sibling must be the seed's name plus a suffix, or vice versa —
   * "Kindling Cannabis" → "Kindling Cannabis Mountainside".
   *
   * Matching on a shared first word is far too loose: "Canna Havana",
   * "Canna Cabana" and "Canna Savanna" are three unrelated businesses, and
   * offering them to each other would let a retailer claim 105 stores they
   * don't own — onto their order form and their agreement. Requiring a full
   * prefix keeps the Kindling case and drops the coincidences.
   */
  const isSibling = other => {
    const o = normalize(other);
    if (!o || o === seedNorm) return false;
    if (o.startsWith(seedNorm + ' ') || seedNorm.startsWith(o + ' ')) return true;

    // Or: every content word of the shorter name appears in the longer one,
    // and they share at least two — enough to rule out a single common word.
    const ot = tokens(other);
    const [short, long] = seedTokens.length <= ot.length ? [seedTokens, ot] : [ot, seedTokens];
    if (short.length < 2) return false;
    return short.every(w => long.includes(w));
  };

  const groups = new Map();
  for (const r of index) {
    if (r.bannerId === bannerId) continue;
    if (!isSibling(r.banner)) continue;
    if (!groups.has(r.bannerId)) groups.set(r.bannerId, []);
    groups.get(r.bannerId).push(r);
  }

  return [...groups.entries()]
    .map(([id, rows]) => {
      const open = rows.filter(r => r.status === 'authorized');
      const live = open.length ? open : rows;
      return {
        bannerId: id,
        name: rows[0].banner,
        locationCount: live.length,
        authorizedCount: open.length,
        allCancelled: !open.length,
        cities: [...new Set(live.map(r => r.address.city))].slice(0, 3),
        cityCount: new Set(live.map(r => r.address.city)).size
      };
    })
    .sort((a, b) => b.locationCount - a.locationCount || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/* ------------------------------------------------------------------ *
 * Google Places — hours, phone, website
 * ------------------------------------------------------------------ */

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Anchored on the AGCO street address, which makes this far more reliable than
 * a name-only search — "Canna Cabana" alone could be any of 97 stores, but
 * "Canna Cabana, 38 Mill St E, Acton, ON L7J 1H2" resolves to exactly one.
 */
export async function fetchPlace({ name, street, city, postal }) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) return null;

  const textQuery = [name, street, city, 'ON', postal].filter(Boolean).join(', ');

  try {
    const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': [
          'places.id',
          'places.displayName',
          'places.formattedAddress',
          'places.location',
          'places.nationalPhoneNumber',
          'places.websiteUri',
          'places.regularOpeningHours',
          'places.businessStatus',
          'places.rating',
          'places.userRatingCount'
        ].join(',')
      },
      body: JSON.stringify({ textQuery, regionCode: 'CA', maxResultCount: 1 })
    });

    if (!res.ok) {
      console.error('[enrich] places error', res.status);
      return null;
    }
    const place = (await res.json()).places?.[0];
    if (!place) return null;

    return {
      placeId: place.id,
      name: place.displayName?.text || name,
      formattedAddress: place.formattedAddress || null,
      phone: place.nationalPhoneNumber || null,
      website: place.websiteUri || null,
      lat: place.location?.latitude ?? null,
      lng: place.location?.longitude ?? null,
      status: place.businessStatus || null,
      rating: place.rating ?? null,
      ratingCount: place.userRatingCount ?? null,
      hours: normalizeHours(place.regularOpeningHours)
    };
  } catch (err) {
    console.error('[enrich] places lookup failed:', err.message);
    return null;
  }
}

function normalizeHours(oh) {
  if (!oh?.periods?.length) return null;
  const week = DAYS.map(d => ({ day: d, open: null, close: null, closed: true }));
  for (const p of oh.periods) {
    const i = p.open?.day;
    if (i == null) continue;
    week[i] = { day: DAYS[i], open: hhmm(p.open), close: p.close ? hhmm(p.close) : '24:00', closed: false };
  }
  return week;
}

const hhmm = t => `${String(t.hour ?? 0).padStart(2, '0')}:${String(t.minute ?? 0).padStart(2, '0')}`;

/* ------------------------------------------------------------------ *
 * Hours → plain English
 * ------------------------------------------------------------------ */

const WEEK_ORDER = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function clock(t) {
  if (t === '24:00' || t === '00:00') return 'midnight';
  const [h, m] = t.split(':').map(Number);
  if (h === 12 && m === 0) return 'noon';
  const period = h >= 12 ? 'PM' : 'AM';
  const hr = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${hr} ${period}` : `${hr}:${String(m).padStart(2, '0')} ${period}`;
}

function dayRange(days) {
  if (days.length === 1) return days[0];
  if (days.length === 2) return `${days[0]} and ${days[1]}`;
  if (days.length === 7) return 'every day';
  return `${days[0]} through ${days[days.length - 1]}`;
}

/**
 * "9 AM to 11 PM Monday through Saturday, and 10 AM to 9 PM Sunday."
 *
 * Collapses consecutive days that share hours — reading a seven-row table back
 * to someone is not a conversation.
 */
export function hoursToProse(week) {
  if (!week?.length) return null;

  const byDay = Object.fromEntries(week.map(d => [d.day, d]));
  const ordered = WEEK_ORDER.map(d => byDay[d]).filter(Boolean);
  if (!ordered.length) return null;

  const runs = [];
  for (const d of ordered) {
    const sig = d.closed ? 'closed' : `${d.open}-${d.close}`;
    const last = runs[runs.length - 1];
    if (last && last.sig === sig) last.days.push(d.day);
    else runs.push({ sig, days: [d.day], closed: d.closed, open: d.open, close: d.close });
  }

  const openRuns = runs.filter(r => !r.closed);
  if (!openRuns.length) return null;

  const parts = openRuns.map(r => `${clock(r.open)} to ${clock(r.close)} ${dayRange(r.days)}`);
  let out = parts.length === 1
    ? parts[0]
    : `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;

  const closedDays = runs.filter(r => r.closed).flatMap(r => r.days);
  if (closedDays.length) out += `, closed ${dayRange(closedDays)}`;

  return out;
}

/* ------------------------------------------------------------------ *
 * Stack fingerprinting
 * ------------------------------------------------------------------ */

const POS_SIGNATURES = [
  { id: 'greenline', label: 'Greenline', kind: 'pos', patterns: ['getgreenline.co', 'greenlinepos'] },
  { id: 'cova', label: 'Cova', kind: 'pos', patterns: ['covasoft.net', 'iqmetrix', 'cova.com'] },
  { id: 'blaze', label: 'BLAZE', kind: 'pos', patterns: ['blaze.me', 'blazepay'] },
  { id: 'techpos', label: 'TechPOS', kind: 'pos', patterns: ['techpos.ca'] },
  { id: 'flowhub', label: 'Flowhub', kind: 'pos', patterns: ['flowhub.co'] },
  { id: 'treez', label: 'Treez', kind: 'pos', patterns: ['treez.io'] },
  { id: 'indicaonline', label: 'IndicaOnline', kind: 'pos', patterns: ['indicaonline.com'] }
];

const MENU_SIGNATURES = [
  { id: 'dutchie', label: 'Dutchie', kind: 'menu', patterns: ['dutchie.com', 'embed.dutchie'] },
  { id: 'buddi', label: 'Buddi', kind: 'menu', patterns: ['buddi.io'] },
  { id: 'jane', label: 'Jane', kind: 'menu', patterns: ['iheartjane.com'] },
  { id: 'tymber', label: 'Tymber', kind: 'menu', patterns: ['tymber.io'] },
  { id: 'meadow', label: 'Meadow', kind: 'menu', patterns: ['getmeadow.com'] },
  { id: 'leafly', label: 'Leafly menu', kind: 'menu', patterns: ['leafly.ca/embed', 'leafly.com/embed'] },
  { id: 'weedmaps', label: 'Weedmaps menu', kind: 'menu', patterns: ['weedmaps.com/embed'] },
  { id: 'shopify', label: 'Shopify', kind: 'menu', patterns: ['cdn.shopify.com', 'shopifycdn'] },
  { id: 'poof', label: 'Poof', kind: 'menu', patterns: ['api.poof.ca'] }
];

const PAYMENT_SIGNATURES = [
  { id: 'stripe', label: 'Stripe', kind: 'payments', patterns: ['js.stripe.com', 'stripe.com/v3'] },
  { id: 'moneris', label: 'Moneris', kind: 'payments', patterns: ['moneris.com', 'gateway.moneris'] },
  { id: 'square', label: 'Square', kind: 'payments', patterns: ['squareup.com', 'square.site'] },
  { id: 'clover', label: 'Clover', kind: 'payments', patterns: ['clover.com'] },
  { id: 'helcim', label: 'Helcim', kind: 'payments', patterns: ['helcim.com'] },
  { id: 'globalpayments', label: 'Global Payments', kind: 'payments', patterns: ['globalpay'] },
  { id: 'paymentech', label: 'Chase Paymentech', kind: 'payments', patterns: ['paymentech'] }
];

const ALL_SIGNATURES = [...POS_SIGNATURES, ...MENU_SIGNATURES, ...PAYMENT_SIGNATURES];

/** Read-only, 4s budget, 400KB cap, fails silently. Findings are "detected", never "verified". */
export async function fingerprintSite(url) {
  if (!url) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'PoofOnboarding/1.0 (+https://business.poof.ca)' }
    });
    if (!res.ok) return [];
    const html = (await res.text()).slice(0, 400_000).toLowerCase();
    return ALL_SIGNATURES
      .filter(sig => sig.patterns.some(p => html.includes(p)))
      .map(sig => ({ id: sig.id, label: sig.label, kind: sig.kind, source: 'detected' }));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ *
 * Composition
 * ------------------------------------------------------------------ */

/**
 * Builds the record the retailer confirms on screen.
 *
 * Places is called for the anchor location only — one lookup per signup, not one
 * per store. A 97-location banner confirms per-location hours later in the admin
 * panel rather than paying for 97 lookups at the front door.
 */
export async function buildProfile({ bannerId, bannerIds = [], storeName, locationIds = [] }) {
  const index = loadIndex();

  // A single business can span several banners — Kindling Cannabis is nine —
  // so the profile is built from the union of everything the retailer claimed.
  const wanted = new Set([...(bannerId ? [bannerId] : []), ...bannerIds].filter(Boolean));

  let known = index.filter(r => wanted.has(r.bannerId) || locationIds.includes(r.id));

  // Free-text entry that never touched the typeahead — try to place it anyway.
  if (!known.length && storeName) {
    const hit = searchIndex(storeName, { limit: 1 })[0];
    if (hit && hit.confidence > 0.6) known = index.filter(r => r.bannerId === hit.bannerId);
  }

  const authorized = known.filter(r => r.status === 'authorized');
  const pending = known.filter(r => r.status === 'in_progress' || r.status === 'public_notice');
  const active = authorized.length ? authorized : pending;
  const anchor = active[0] || known[0] || null;

  // With several banners merged, name the record after whichever contributes
  // the most doors — "Kindling Cannabis", not "Kindling Cannabis Meadowvale".
  let displayName = anchor?.banner || storeName;
  if (wanted.size > 1 && active.length) {
    const counts = new Map();
    for (const r of active) counts.set(r.banner, (counts.get(r.banner) || 0) + 1);
    displayName = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0][0];
  }

  const place = anchor
    ? await fetchPlace({
        name: anchor.banner,
        street: anchor.address.street,
        city: anchor.address.city,
        postal: anchor.address.postal
      })
    : await fetchPlace({ name: storeName, city: 'Ontario' });

  const website = anchor?.website || place?.website || null;
  const detected = await fingerprintSite(website);

  // A live POS integration from our own index always outranks a website guess.
  const stack = [];
  const seen = new Set();
  for (const r of active) {
    if (r.pos && !seen.has(r.pos)) {
      seen.add(r.pos);
      stack.push({
        id: r.pos,
        label: POS_SIGNATURES.find(s => s.id === r.pos)?.label || r.pos,
        kind: 'pos',
        source: r.integrated ? 'verified' : 'detected'
      });
    }
  }
  for (const d of detected) if (!seen.has(d.id)) { seen.add(d.id); stack.push(d); }

  const locations = (active.length ? active : known).map(r => ({
    id: r.id,
    name: r.address.city,
    address: [r.address.street, r.address.city, r.address.postal].filter(Boolean).join(', '),
    licenceNumber: r.licenceNumber,
    status: r.status,
    pos: r.pos || null,
    integrated: !!r.integrated,
    source: 'agco'
  }));

  const hours = place?.hours || null;

  return {
    storeName: field(displayName, known.length ? 'agco' : 'entered'),
    licenceNumber: field(anchor?.licenceNumber || null, anchor?.licenceNumber ? 'agco' : null),
    address: field(locations[0]?.address || null, anchor ? 'agco' : null),
    website: field(website, anchor?.website ? 'agco' : place?.website ? 'google' : null),
    phone: field(place?.phone || null, place?.phone ? 'google' : null),
    hours: { value: hours, prose: hoursToProse(hours), source: hours ? 'google' : null, editable: true },
    rating: place?.rating ? { value: place.rating, count: place.ratingCount, source: 'google' } : null,
    locations,
    stack,
    status: {
      authorized: authorized.length,
      pending: pending.length,
      cancelled: known.length - authorized.length - pending.length,
      overall: authorized.length ? 'authorized'
        : pending.length ? 'pending'
        : known.length ? 'cancelled' : 'unknown'
    },
    coverage: { known: known.length, integrated: active.filter(r => r.integrated).length }
  };
}

const field = (value, source) => ({ value: value ?? null, source: source ?? null, editable: true });

export const SIGNATURE_LABELS = Object.fromEntries(ALL_SIGNATURES.map(s => [s.id, s.label]));
