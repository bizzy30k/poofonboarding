/**
 * vendors.js — the single source of truth for the stack options a retailer picks.
 *
 * The front end renders from this, the PDF agreement prints from it, and the
 * tracker's dropdowns are generated from it. One list, three surfaces, so a new
 * POS never gets added in two places and forgotten in the third.
 *
 * `needsApi` marks vendors we will have to collect API credentials for during
 * setup. Those credentials are NEVER collected in the onboarding chat — the flow
 * only records which vendors are in play and flags the account for follow-up in
 * the authenticated admin panel.
 */

export const POS_OPTIONS = [
  { id: 'cova', label: 'Cova', needsApi: true },
  { id: 'greenline', label: 'Greenline', needsApi: true },
  { id: 'other', label: 'Other', needsApi: true, freeText: true }
];

export const PAYMENT_OPTIONS = [
  { id: 'merrco', label: 'Merrco' },
  { id: 'moneris', label: 'Moneris' },
  { id: 'blazepay', label: 'BlazePay' },
  { id: 'covapay', label: 'CovaPay' },
  { id: 'other', label: 'Other', freeText: true }
];

export const ECOMMERCE_OPTIONS = [
  { id: 'buddi', label: 'Buddi', needsApi: true },
  { id: 'dutchie', label: 'Dutchie', needsApi: true },
  { id: 'breadstack', label: 'Breadstack', needsApi: true },
  { id: 'none', label: 'Just our POS menu' },
  { id: 'other', label: 'Other', needsApi: true, freeText: true }
];

export const DELIVERY_OPTIONS = [
  { id: 'canfleet', label: 'Canfleet', needsApi: true },
  { id: 'onfleet', label: 'Onfleet', needsApi: true },
  { id: 'other', label: 'Something else', freeText: true },
  { id: 'in_house', label: 'In-house (no software)' }
];

const byId = list => Object.fromEntries(list.map(o => [o.id, o]));

export const ECOMMERCE_BY_ID = byId(ECOMMERCE_OPTIONS);
export const POS_BY_ID = byId(POS_OPTIONS);
export const PAYMENT_BY_ID = byId(PAYMENT_OPTIONS);
export const DELIVERY_BY_ID = byId(DELIVERY_OPTIONS);

/** Human label for a stored answer, falling back to whatever they typed. */
export function labelFor(list, value, freeText) {
  if (!value) return null;
  const opt = list.find(o => o.id === value);
  if (!opt) return value;
  if (opt.freeText && freeText) return freeText;
  return opt.label;
}

/**
 * Which integrations this retailer will need credentials for.
 * Drives the ops follow-up list, not anything the retailer is asked to type.
 */
export function pendingIntegrations(stack = {}) {
  const out = [];
  const add = (system, vendor) => vendor && out.push({ system, vendor });

  add('POS', labelFor(POS_OPTIONS, stack.pos, stack.posOther));
  if (stack.ecommerce && stack.ecommerce !== 'none') {
    add('E-commerce', labelFor(ECOMMERCE_OPTIONS, stack.ecommerce, stack.ecommerceOther));
  }
  if (stack.delivers && stack.deliverySoftware) {
    add('Last-mile delivery', labelFor(DELIVERY_OPTIONS, stack.deliverySoftware, stack.deliveryOther));
  }
  return out.filter(x => x.vendor && x.vendor !== 'In-house (no software)');
}
