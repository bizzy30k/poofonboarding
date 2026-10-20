// Listing claims — the "claim your listing" step that comes before the signup.
//
// A claim is a store owner saying "this AGCO listing is mine" and giving us a logo, contact
// details, a description and hours. No Stripe customer exists yet, so the record can't live on
// Stripe metadata like the signup does. It lives in Vercel Blob instead:
//
//   claims/<CRSA>/logo.<ext>   public   — the logo, served from a stable URL (referenced by core's imageUrl)
//   claims/<CRSA>/claim.json   private  — the record (contact email + phone, so never public)
//
// Everything here is the storage seam. Core-team port: swap `putLogo`/`putRecord`/`getRecord`/
// `listRecords` for the core client; `toCoreListing()` already produces core's field names.
const config = require('./config');

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const T12 = /^(1[0-2]|0?[1-9]):[0-5]\d [AP]M$/; // "10:00 AM", "10:30 PM"
const LOGO_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const LOGO_MAX_BYTES = 600 * 1024; // the page resizes to ≤512px before upload, so this is generous

function blob() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error('BLOB_READ_WRITE_TOKEN is not set');
  return require('@vercel/blob');
}

// ---- validation ----------------------------------------------------------------------------

/**
 * `{ monday: { open: '10:00 AM', close: '10:00 PM' } | null, … }` — 12-hour clock, null = closed.
 * Required: at least one open day. Returns undefined if missing or malformed.
 */
function hours(v) {
  if (v == null || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out = {};
  let open = 0;
  const norm = (t) => String(t || '').trim().replace(/\s+/g, ' ').replace(/([ap])\.?m\.?$/i, (m, p) => p.toUpperCase() + 'M');
  for (const d of DAYS) {
    const x = v[d];
    if (x == null) { out[d] = null; continue; }
    if (typeof x !== 'object') return undefined;
    const o = norm(x.open); const c = norm(x.close);
    if (!T12.test(o) || !T12.test(c)) return undefined;
    out[d] = { open: o, close: c };
    open++;
  }
  return open ? out : undefined;
}

/** Data URL → { buf, ext, type }; undefined when not an allowed image or too large. Magic bytes checked. */
function logo(dataUrl) {
  if (dataUrl == null || dataUrl === '') return null;
  const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl));
  if (!m) return undefined;
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length || buf.length > LOGO_MAX_BYTES) return undefined;
  const png = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const jpg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const webp = buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP';
  const ok = (m[1] === 'image/png' && png) || (m[1] === 'image/jpeg' && jpg) || (m[1] === 'image/webp' && webp);
  return ok ? { buf, ext: LOGO_TYPES[m[1]], type: m[1] } : undefined;
}

function website(v) {
  if (v == null || v === '') return '';
  let s = String(v).trim().slice(0, 200);
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try { const u = new URL(s); return /^https?:$/.test(u.protocol) && u.hostname.includes('.') ? u.href : undefined; } catch (e) { return undefined; }
}

/** "@thewestore", "thewestore", "instagram.com/thewestore" → "thewestore". */
function instagram(v) {
  if (v == null || v === '') return '';
  const s = String(v).trim().replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/^@/, '').replace(/\/.*$/, '');
  return /^[A-Za-z0-9._]{1,30}$/.test(s) ? s : undefined;
}

function phone(v) {
  if (v == null || v === '') return '';
  const d = String(v).replace(/\D/g, '').replace(/^1(\d{10})$/, '$1');
  return d.length === 10 ? d : undefined;
}

// ---- storage -------------------------------------------------------------------------------

async function putLogo(id, img) {
  const { put } = blob();
  const r = await put(`claims/${id}/logo.${img.ext}`, img.buf, { access: 'public', contentType: img.type, addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 60 });
  return r.url;
}

async function putRecord(rec) {
  const { put } = blob();
  await put(`claims/${rec.id}/claim.json`, JSON.stringify(rec), { access: 'private', contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true });
  return rec;
}

async function getRecord(id) {
  const { get } = blob();
  const r = await get(`claims/${id}/claim.json`, { access: 'private', useCache: false }).catch(e => { if (e && e.name === 'BlobNotFoundError') return null; throw e; });
  if (!r || r.statusCode !== 200) return null;
  const text = await new Response(r.stream).text();
  try { return JSON.parse(text); } catch (e) { return null; }
}

async function listRecords() {
  const { list } = blob();
  const ids = [];
  let cursor;
  do {
    const page = await list({ prefix: 'claims/', cursor, limit: 1000 });
    for (const b of page.blobs) { const m = /^claims\/(CRSA\d+)\/claim\.json$/.exec(b.pathname); if (m) ids.push(m[1]); }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  const recs = await Promise.all(ids.map(getRecord));
  return recs.filter(Boolean).sort((a, b) => String(b.submittedAt).localeCompare(String(a.submittedAt)));
}

// ---- core shape ----------------------------------------------------------------------------

/**
 * The fields a claim fills in on core's store document. Keys are core's own (see
 * handover/core-integration.md); `operationHours` shape is proposed in handover/claim-page.md.
 */
function toCoreListing(rec) {
  const l = rec.listing;
  return {
    imageUrl: l.logoUrl || null,
    description: l.description || null,
    contactName: rec.contact.name,
    contactEmail: l.email || rec.contact.email,
    contactNumber: l.phone || '',
    website: l.website || null,
    instagramUrl: l.instagram ? `https://instagram.com/${l.instagram}` : null,
    operationHours: l.hours,
    isProfileComplete: !!(l.logoUrl && l.description && l.hours && l.phone && l.website),
    poof: { stage: rec.status === 'published' ? 'live' : 'claimed', claimedAt: rec.submittedAt, onboardingUrl: `${config.SITE_URL}/s/${rec.id}` },
  };
}

module.exports = { DAYS, v: { hours, logo, website, instagram, phone }, putLogo, putRecord, getRecord, listRecords, toCoreListing, LOGO_MAX_BYTES };
