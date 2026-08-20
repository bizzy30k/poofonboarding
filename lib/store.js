/**
 * store.js — holds an in-progress onboarding submission between the browser
 * and the Stripe webhook.
 *
 * Stripe metadata caps at 500 characters per value, which a multi-location
 * submission with hours will blow past. So we persist the submission and pass
 * only its id through Checkout.
 *
 * Set KV_REST_API_URL + KV_REST_API_TOKEN (Vercel KV / Upstash Redis) in
 * production. Without them this falls back to process memory, which does not
 * survive a cold start — fine for local dev, not for real signups.
 */

const memory = new Map();
const TTL_SECONDS = 60 * 60 * 24; // a signup that stalls past a day starts over

const kvUrl = process.env.KV_REST_API_URL;
const kvToken = process.env.KV_REST_API_TOKEN;
export const usingDurableStore = Boolean(kvUrl && kvToken);

if (!usingDurableStore) {
  console.warn('[store] KV not configured — submissions are held in memory only.');
}

async function kv(command) {
  const res = await fetch(`${kvUrl}/${command.map(encodeURIComponent).join('/')}`, {
    headers: { Authorization: `Bearer ${kvToken}` }
  });
  if (!res.ok) throw new Error(`KV ${res.status}`);
  return (await res.json()).result;
}

export async function putSubmission(id, payload) {
  const body = JSON.stringify({ ...payload, _savedAt: new Date().toISOString() });
  if (usingDurableStore) {
    await kv(['set', `onboarding:${id}`, body, 'EX', String(TTL_SECONDS)]);
    return id;
  }
  memory.set(id, body);
  setTimeout(() => memory.delete(id), TTL_SECONDS * 1000).unref?.();
  return id;
}

export async function getSubmission(id) {
  let raw;
  if (usingDurableStore) {
    raw = await kv(['get', `onboarding:${id}`]);
  } else {
    raw = memory.get(id);
  }
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function markSubmission(id, patch) {
  const existing = await getSubmission(id);
  if (!existing) return null;
  const next = { ...existing, ...patch };
  await putSubmission(id, next);
  return next;
}

export const newId = () =>
  `onb_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
