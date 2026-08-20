/**
 * tracker.js — one row per onboarded store, appended to a Google Sheet.
 *
 * The column order here is the contract. It matches the header row in
 * Poof-Retailer-Onboarding-Tracker.xlsx exactly, so the spreadsheet and this
 * code can't drift. If you add a column, add it in both places, at the end.
 *
 * Auth uses a Google service account. Share the sheet with the service account's
 * email as an Editor — that's the whole setup. If GOOGLE_SERVICE_ACCOUNT_JSON
 * isn't set, rows are logged as CSV instead so nothing is silently lost.
 */

import crypto from 'node:crypto';
import { POS_OPTIONS, PAYMENT_OPTIONS, DELIVERY_OPTIONS, ECOMMERCE_OPTIONS, labelFor, pendingIntegrations } from './vendors.js';

export const TRACKER_COLUMNS = [
  'Submission ID',
  'Signed up (UTC)',
  'Status',
  'Store name',
  'Banner locations',
  'Primary city',
  'AGCO licence',
  'AGCO status',
  'Hours',
  'Store phone',
  'Website',
  'Owner name',
  'Owner email',
  'Owner phone',
  'POS',
  'Payment processor',
  'E-commerce platform',
  'Offers delivery',
  'Delivery software',
  'Wants delivery',
  'Integrations pending',
  'Surfaces',
  'Referral code',
  'Referring brand',
  'Credit months',
  'Card on file',
  'Stripe customer',
  'Stripe subscription',
  'Go-live date',
  'Agreement sent',
  'Accepted by',
  'Accepted at (UTC)',
  'Terms version',
  'Notes'
];

export function submissionToRow(s = {}) {
  const p = s.profile || {};
  const stack = s.stack || {};
  const locs = s.confirmedLocations?.length ? s.confirmedLocations : (p.locations || []);
  const goalNames = { marketplace: 'Marketplace', ecommerce: 'E-commerce', adnetwork: 'Ad network' };

  return [
    s.id || '',
    (s.createdAt || new Date().toISOString()).replace('T', ' ').slice(0, 19),
    STATUS_LABEL[s.status] || s.status || '',
    p.storeName?.value || '',
    locs.length || 0,
    locs[0]?.name || '',
    locs.length === 1 ? (p.licenceNumber?.value || '') : locs.map(l => l.licenceNumber).filter(Boolean).join(' | '),
    p.status?.overall || '',
    p.hours?.prose || '',
    p.phone?.value || '',
    p.website?.value || '',
    s.contact?.name || '',
    s.contact?.email || '',
    s.contact?.phone || '',
    labelFor(POS_OPTIONS, stack.pos, stack.posOther) || '',
    labelFor(PAYMENT_OPTIONS, stack.payment, stack.paymentOther) || '',
    labelFor(ECOMMERCE_OPTIONS, stack.ecommerce, stack.ecommerceOther) || '',
    stack.delivers ? 'Yes' : 'No',
    stack.delivers ? (labelFor(DELIVERY_OPTIONS, stack.deliverySoftware, stack.deliveryOther) || '') : '',
    stack.delivers ? 'Already delivers' : stack.wantsDelivery ? 'Yes' : stack.wantsDelivery === false ? 'No' : '',
    pendingIntegrations(stack).map(i => i.vendor).join(', '),
    (s.goals || []).map(g => goalNames[g] || g).join(', '),
    s.referral?.code || '',
    s.referral?.brand || '',
    s.referral?.monthsCredited || '',
    s.paymentMethodId ? 'Yes' : 'No',
    s.stripeCustomerId || '',
    s.stripeSubscriptionId || '',
    s.goLiveDate || '',
    s.agreementSentAt ? s.agreementSentAt.slice(0, 10) : '',
    s.acceptance ? `${s.acceptance.acceptedBy}${s.acceptance.acceptedTitle ? ', ' + s.acceptance.acceptedTitle : ''}` : '',
    s.acceptance?.acceptedAt ? s.acceptance.acceptedAt.replace('T', ' ').slice(0, 19) : '',
    s.acceptance?.termsVersion || '',
    ''
  ];
}

const STATUS_LABEL = {
  awaiting_payment_method: 'Awaiting card',
  onboarded: 'Onboarded — pending go-live',
  live: 'Live',
  cancelled: 'Cancelled'
};

/* ------------------------------------------------------------------ *
 * Google Sheets
 * ------------------------------------------------------------------ */

const SHEET_ID = process.env.TRACKER_SHEET_ID;
const SHEET_TAB = process.env.TRACKER_SHEET_TAB || 'Onboarded stores';

/**
 * Appends the store, or updates its row if it's already there.
 * Idempotent on submission id, so a Stripe webhook retry doesn't duplicate.
 */
export async function appendToTracker(submission) {
  const row = submissionToRow(submission);

  if (!SHEET_ID || !process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    console.log('[tracker] sheet not configured, row follows as CSV:');
    console.log(row.map(csvCell).join(','));
    return { logged: true };
  }

  try {
    const token = await getAccessToken();
    const existingRow = await findRow(token, submission.id);

    if (existingRow) {
      await sheets(token, `PUT`, `/values/${range(`A${existingRow}`, `AD${existingRow}`)}?valueInputOption=USER_ENTERED`,
        { values: [row] });
      return { updated: true, row: existingRow };
    }

    await sheets(token, 'POST', `/values/${range('A1', 'AD1')}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      { values: [row] });
    return { appended: true };
  } catch (err) {
    console.error('[tracker] append failed:', err.message);
    console.log('[tracker] row follows as CSV:');
    console.log(row.map(csvCell).join(','));
    return { failed: true };
  }
}

const range = (a, b) => encodeURIComponent(`${SHEET_TAB}!${a}:${b}`);

async function findRow(token, submissionId) {
  if (!submissionId) return null;
  const res = await sheets(token, 'GET', `/values/${range('A1', 'A5000')}`);
  const rows = res.values || [];
  const i = rows.findIndex(r => r[0] === submissionId);
  return i === -1 ? null : i + 1;
}

async function sheets(token, method, pathSuffix, body) {
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}${pathSuffix}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) throw new Error(`Sheets ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/* --- service account JWT, no googleapis dependency --- */

let _token = null;

async function getAccessToken() {
  if (_token && _token.expires > Date.now() + 60_000) return _token.value;

  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const now = Math.floor(Date.now() / 1000);

  const claim = {
    iss: creds.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  };

  const b64 = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claim)}`;
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(creds.private_key, 'base64url');

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${signature}`
    })
  });
  if (!res.ok) throw new Error(`Token ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const data = await res.json();
  _token = { value: data.access_token, expires: Date.now() + data.expires_in * 1000 };
  return _token.value;
}

const csvCell = v => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
