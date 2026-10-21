// Google Places — one lookup per store (find → details), cached per instance, capped per minute.
// Used by /api/lookup (prefill on the page) and /api/claim-bulk (phone + hours per sibling store).
const config = require('./config');
const sec = require('./security');

const cache = new Map(); // storeId → { at, data }
const TTL = 6 * 3600e3;

async function places(store) {
  if (!config.GOOGLE_PLACES_KEY) return null;
  const hit = cache.get(store.id);
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  if (!sec.rateLimit('places:global', 30, 60e3)) return null; // soft cap: 30 Places lookups / min / instance
  try {
    const q = encodeURIComponent(`${store.name} ${store.addr} ${store.city} Ontario`);
    const f = await sec.fetchT(`https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${q}&inputtype=textquery&fields=place_id&key=${config.GOOGLE_PLACES_KEY}`);
    const j = await f.json();
    const id = j.candidates && j.candidates[0] && j.candidates[0].place_id;
    if (!id) return null;
    const d = await sec.fetchT(`https://maps.googleapis.com/maps/api/place/details/json?place_id=${id}&fields=rating,user_ratings_total,formatted_phone_number,website,opening_hours&key=${config.GOOGLE_PLACES_KEY}`);
    const r = (await d.json()).result || {};
    const data = {
      rating: r.rating || null,
      ratings: r.user_ratings_total || null,
      phone: r.formatted_phone_number || null,
      website: /^https?:\/\//i.test(r.website || '') ? r.website : null,
      hours: r.opening_hours && r.opening_hours.weekday_text ? r.opening_hours.weekday_text : null,
    };
    cache.set(store.id, { at: Date.now(), data });
    return data;
  } catch (e) { return null; }
}

// ---- weekday_text → claim hours ({ monday: { open: '10:00 AM', close: '9:00 PM' } | null, … }) ----
const DAYS = { mon: 'monday', tue: 'tuesday', wed: 'wednesday', thu: 'thursday', fri: 'friday', sat: 'saturday', sun: 'sunday' };
const TIME = /(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/gi;

function to12(h, m, ampm) {
  let p = ampm ? ampm.toLowerCase().replace(/\./g, '').toUpperCase() : null;
  let hh = h;
  if (!p) { p = hh >= 12 ? 'PM' : 'AM'; hh = hh % 12 || 12; } // bare 24h number
  else { hh = hh % 12 || 12; }
  return `${hh}:${String(m).padStart(2, '0')} ${p}`;
}

/** "Monday: 10:00 AM – 9:00 PM" → ['monday', { open, close }]; "…: Closed" → ['monday', null]; undefined if unparseable. */
function parseWeekdayLine(line) {
  const clean = String(line).replace(/[   ]/g, ' ').trim();
  const m = /^([A-Za-z]+)\s*:\s*(.*)$/.exec(clean);
  if (!m) return undefined;
  const day = DAYS[m[1].slice(0, 3).toLowerCase()];
  if (!day) return undefined;
  const rest = m[2].trim();
  if (/closed/i.test(rest)) return [day, null];
  if (/open 24 hours/i.test(rest)) return [day, { open: '12:00 AM', close: '11:59 PM' }];
  const times = [...rest.matchAll(TIME)].filter(t => t[0].trim());
  if (times.length < 2) return undefined;
  const first = times[0]; const last = times[times.length - 1];
  const ampmFirst = first[3] || (last[3] && Number(first[1]) <= 12 ? last[3] : undefined);
  return [day, { open: to12(Number(first[1]), Number(first[2] || 0), ampmFirst), close: to12(Number(last[1]), Number(last[2] || 0), last[3]) }];
}

/** Places weekday_text → hours object, or null when nothing parses. Days not mentioned are closed. */
function hoursFromWeekdayText(lines) {
  if (!Array.isArray(lines) || !lines.length) return null;
  const out = { monday: null, tuesday: null, wednesday: null, thursday: null, friday: null, saturday: null, sunday: null };
  let any = false;
  for (const l of lines) { const r = parseWeekdayLine(l); if (!r) continue; out[r[0]] = r[1]; any = true; }
  return any ? out : null;
}

module.exports = { places, parseWeekdayLine, hoursFromWeekdayText };
