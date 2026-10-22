// Listing claims — the "claim your listing" step that comes before the signup.
//
// A claim is a store owner saying "this AGCO listing is mine" and giving us a logo, contact
// details, a description and hours. No Stripe customer exists yet, so the record can't live on
// Stripe metadata like the signup does. It lives in Vercel Blob instead:
//
//   claims/<CRSA>/logo.<ext>   public    — the logo, served from a stable URL (referenced by core's imageUrl)
//   claims/<CRSA>/claim.enc    encrypted — the record (AES-256-GCM, key derived from SIGNING_SECRET), so the
//                                          owner's contact details are unreadable even though the store is public
//
// Everything here is the storage seam. Core-team port: swap `putLogo`/`putRecord`/`getRecord`/
// `listRecords` for the core client; `toCoreListing()` already produces core's field names.
const crypto = require('crypto');
const config = require('./config');

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const T12 = /^(1[0-2]|0?[1-9]):[0-5]\d [AP]M$/; // "10:00 AM", "10:30 PM"
const LOGO_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const LOGO_MAX_BYTES = 600 * 1024;
// Blob folder. Production uses claims/; preview (dev branch) deployments use claims-dev/ so the team can test
// claims without locking real stores. Override with CLAIMS_ROOT.
const ROOT = (process.env.CLAIMS_ROOT && process.env.CLAIMS_ROOT.trim()) || (process.env.VERCEL_ENV === 'production' ? 'claims' : 'claims-dev');

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
  const r = await put(`${ROOT}/${id}/logo.${img.ext}`, img.buf, { access: 'public', contentType: img.type, addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 60 });
  return r.url;
}

// ---- record encryption (one public store; records must not be readable by URL) ----
function recordKey() { return crypto.createHash('sha256').update(`claims:${config.signingSecret()}`).digest(); }
function seal(obj) {
  const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', recordKey(), iv);
  const body = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]); // 12-byte iv · 16-byte tag · ciphertext
}
function open(buf) {
  if (!buf || buf.length < 29) return null;
  const d = crypto.createDecipheriv('aes-256-gcm', recordKey(), buf.subarray(0, 12)); d.setAuthTag(buf.subarray(12, 28));
  try { return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8')); } catch (e) { return null; }
}

async function putRecord(rec) {
  const { put } = blob();
  await put(`${ROOT}/${rec.id}/claim.enc`, seal(rec), { access: 'public', contentType: 'application/octet-stream', addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 0 });
  return rec;
}

async function getRecord(id) {
  const { get } = blob();
  const r = await get(`${ROOT}/${id}/claim.enc`, { access: 'public', useCache: false }).catch(e => { if (e && e.name === 'BlobNotFoundError') return null; throw e; });
  if (!r || r.statusCode !== 200) return null;
  return open(Buffer.from(await new Response(r.stream).arrayBuffer()));
}

/** Every CRSA with a claim record on file — one Blob list call, no decryption. */
async function claimedIds() {
  const { list } = blob();
  const ids = new Set();
  let cursor;
  do {
    const page = await list({ prefix: `${ROOT}/`, cursor, limit: 1000 });
    for (const b of page.blobs) { const m = new RegExp(`^${ROOT}/(CRSA\\d+)/claim\\.enc$`).exec(b.pathname); if (m) ids.add(m[1]); }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return ids;
}

/** Admin "release": the owner wrote in saying "I didn't claim this". Removes the record; the logo stays (harmless, overwritten next time). */
async function deleteRecord(id) {
  const { del } = blob();
  const r = await getRecord(id);
  if (!r) return false;
  await del(`${ROOT}/${id}/claim.enc`);
  return true;
}

// ---- ownership (edit links) ------------------------------------------------------------------
// A claim locks the listing: nobody else can submit for that CRSA. The owner's confirmation email
// carries a signed link that reopens the form. The token binds the CRSA to the claiming email, so a
// forwarded link still only edits what that owner claimed.
function editToken(id, email) { return config.sign(`${id}:${String(email || '').toLowerCase()}`, 'claim-edit'); }
function checkEditToken(rec, token) { return !!(rec && rec.contact && token && config.verify(`${rec.id}:${String(rec.contact.email).toLowerCase()}`, String(token), 'claim-edit')); }

/** What anyone may see about a claimed store (no contact details). */
function publicStatus(rec) {
  return rec ? { claimed: true, status: rec.status, claimedAt: rec.claimedAt || rec.submittedAt, storeName: rec.storeName, revision: rec.revision || 1 } : { claimed: false };
}

/**
 * Ownership signals for the internal email — so approval is a 10-second read, not an investigation.
 * LIKELY: the claimant's email is on the store's own domain, or the phone matches Google's.
 * REVIEW: free-mail address and nothing matches, or the phone/website differ from Google.
 */
const FREE_MAIL = /^(gmail|googlemail|hotmail|outlook|live|yahoo|icloud|me|protonmail|proton|aol|mail)\.(com|ca|co\.uk|net)$/i;
function ownership(rec, g) {
  const l = rec.listing || {};
  const email = String(rec.contact && rec.contact.email || '').toLowerCase();
  const emailDomain = email.split('@')[1] || '';
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch (e) { return ''; } };
  const siteHost = host(l.website);
  const gHost = host(g && g.website);
  const digits = (v) => String(v || '').replace(/\D/g, '').replace(/^1(\d{10})$/, '$1');
  const gPhone = digits(g && g.phone);
  const pros = []; const cons = [];
  if (emailDomain && siteHost && (emailDomain === siteHost || siteHost.endsWith('.' + emailDomain) || emailDomain.endsWith('.' + siteHost))) pros.push(`email domain matches website (${emailDomain})`);
  else if (FREE_MAIL.test(emailDomain)) cons.push(`free-mail address (${emailDomain})`);
  else if (emailDomain) cons.push(`email domain ${emailDomain} ≠ website ${siteHost || '—'}`);
  if (gPhone && l.phone) { if (gPhone === l.phone) pros.push('phone matches Google'); else cons.push(`phone ${l.phone} ≠ Google ${gPhone}`); }
  else if (!gPhone) cons.push('Google has no phone to compare');
  if (gHost && siteHost) { if (gHost === siteHost) pros.push('website matches Google'); else cons.push(`website ${siteHost} ≠ Google ${gHost}`); }
  const verdict = pros.length ? 'LIKELY' : 'REVIEW';
  return { verdict, pros, cons, line: `${verdict} — ${[...pros, ...cons].join('; ') || 'nothing to compare'}` };
}

/** Other stores on the same licence that nobody has claimed yet — the "claim the rest" list. */
async function unclaimedSiblings(store, chain) {
  if (!store || !chain || !Array.isArray(chain.stores) || chain.stores.length < 2) return [];
  const taken = await claimedIds().catch(() => new Set());
  return chain.stores.filter(s => s.id !== store.id && !taken.has(s.id)).map(s => ({ id: s.id, name: s.name, addr: s.addr, city: s.city, postal: s.postal }));
}

async function listRecords() {
  const { list } = blob();
  const ids = [];
  let cursor;
  do {
    const page = await list({ prefix: `${ROOT}/`, cursor, limit: 1000 });
    for (const b of page.blobs) { const m = new RegExp(`^${ROOT}/(CRSA\\d+)/claim\\.enc$`).exec(b.pathname); if (m) ids.push(m[1]); }
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
    hqStoreId: rec.hq ? rec.hq.id : null,
    hqUrl: rec.hq ? rec.hq.url : null,
    poof: { stage: rec.status === 'published' ? 'live' : 'claimed', claimedAt: rec.claimedAt || rec.submittedAt, onboardingUrl: `${config.SITE_URL}/s/${rec.id}` },
  };
}

module.exports = { DAYS, v: { hours, logo, website, instagram, phone }, putLogo, putRecord, getRecord, deleteRecord, listRecords, claimedIds, unclaimedSiblings, editToken, checkEditToken, publicStatus, ownership, toCoreListing, LOGO_MAX_BYTES };
