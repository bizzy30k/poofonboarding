# onboarding.poof.ca ↔ Poof HQ core — integration contract

**Status:** live on the onboarding side as of 2026-10-19. Core side: three small tasks below.

## The model

- **onboarding.poof.ca** (Vercel) is the retailer **front door**: AGCO-verified store pick, locations, systems, agreement, card. Each signup is a Stripe customer; the full record lives in its metadata. No database.
- **Poof HQ core** (`api.poof.ca/v1`) is the **system of record** for stores. The onboarding side sends every signup to core *in core's own store-document shape*, keyed by `license.licenseNumber` (CRSA). Core upserts; nothing to translate.
- Core never feeds the onboarding flow. The AGCO list is baked into the flow and rebuilt from the register (`scripts/import-agco.js`). Dependency runs one way: **onboarding → core**.

## Two ways to receive signups (same payload)

### 1. Push — webhook (recommended)

Set on Vercel: `CORE_WEBHOOK_URL=https://api.poof.ca/v1/…/onboarding` and `CORE_WEBHOOK_SECRET=<shared>`.

| Header | Value |
|---|---|
| `x-poof-event` | `signup.accepted` (agreement + card/skip done) · `signup.activated` (go-live; `stores[]` = only the activated doors) |
| `x-poof-signature` | hex HMAC-SHA256 of the **raw body** with `CORE_WEBHOOK_SECRET` |
| `x-poof-source` | `onboarding.poof.ca` |

Verify (Node):
```js
const ok = crypto.timingSafeEqual(
  Buffer.from(req.headers['x-poof-signature'], 'hex'),
  crypto.createHmac('sha256', process.env.CORE_WEBHOOK_SECRET).update(rawBody).digest());
```
Respond 2xx. Delivery is fire-and-forget (the retailer is never blocked on core); failures are logged on Vercel. Use the pull endpoint to reconcile.

### 2. Pull — export endpoint

```
GET https://onboarding.poof.ca/api/core-export
    x-admin-key: <ADMIN_KEY>
    ?since=2026-10-19T00:00:00Z     signups accepted after this time
    &stage=accepted,live            default accepted+live; add in_progress to see abandoned
    &licenseNumber=CRSA1537578      one store document
    &customerId=cus_…               one signup
    &limit=100                      max 500
→ { count, signups: [ <envelope> ] }
```
Poll nightly if you'd rather not run a webhook. Identical shape.

## Envelope

```jsonc
{
  "event": "signup.accepted",
  "sentAt": "…",
  "account": {
    "stripeCustomerId": "cus_…",
    "chainName": "Sessions Cannabis", "chainSlug": "sessions-cannabis",
    "owner": { "name", "email", "mobile" },
    "locationCount": 50,
    "groups":    [ { "name": "Windsor-Essex", "licenseNumbers": ["CRSA…"] } ],   // retailer's own regional grouping
    "conflicts": [ { "stripeCustomerId", "licenseNumbers", "stage" } ]           // doors already claimed by another signup (franchise guard)
  },
  "stores": [ <core store document>, … ]     // one per CRSA on the signup
}
```

## Core store document (one per licence)

Field names and nesting are copied from `GET /v1/admin/store/:id` on production. Upsert on `license.licenseNumber`.

```jsonc
{
  "name": "Sessions Cannabis - Amherstburg",       // AGCO store name, title-cased
  "displayAs": "Sessions Cannabis",                // chain / brand name the retailer confirmed
  "slug": "sessions-cannabis-amherstburg-527-…",   // suggestion; regenerate if core owns slugs
  "description": null, "imageUrl": null,
  "source": "onboarding",                          // vs "imported" for AGCO loads

  "license":  { "licenseNumber": "CRSA1537578", "licenseName": "…", "dateRegistered": null, "dateExpired": null },
  "location": { "address": "527 Sandwich St S Unit 440", "city": "Amherstburg", "province": "ON", "country": "Canada", "postalCode": "N9V 3G5" },
  "geolocation": { "type": "Point", "coordinates": [lng, lat] },

  "contactName": "…", "contactEmail": "…", "contactNumber": "4165550100", "website": "https://…",
  "facebookUrl": null, "instagramUrl": null, "xUrl": null,

  "posIntegration": "Greenline",                   // Cova | Greenline | Blaze | Dutchie POS | Tendy | Other
  "paymentSolution": "Merrco",                     // Merrco | Moneris | Clover | Other
  "acceptablePayment": [],
  "breadStackIntegration": {} | { "requested": true },
  "deliveryInformation": { "hasDelivery": true, "note": "Canfleet" },
  "deliveryZones": [], "operationHours": null,     // not collected in the flow (HQ steps 6–7)

  "isActive": false, "isValidated": false, "isProfileComplete": false,   // core decides; safe defaults

  "poof": {                                        // Poof-side facts, namespaced — keep or drop
    "stripeCustomerId", "stripeSubscriptionId",
    "stage": "in_progress" | "accepted" | "live",
    "entryStoreId", "chainSlug", "group", "ecommerce",
    "cardOnFile": true|false|null, "offer": { "code": "LAUNCH3", "months": 3 } | null, "referralCode",
    "agreement": { "acceptedBy", "title", "at", "termsVersion", "termsHash", "ip" } | null,
    "orderFormUrl", "onboardingUrl": "https://onboarding.poof.ca/s/CRSA1537578"
  }
}
```

### Suggested core behaviour
| Event | Core action |
|---|---|
| `signup.accepted` | upsert store by licence; set `contact*`, `posIntegration`, `paymentSolution`, `deliveryInformation`, `website`; store `poof.*`; leave `isActive=false`. Attach owner user (`/admin/store/:id/users`) from `account.owner.email` if you create accounts here. |
| `signup.activated` | set `isActive=true` on the listed licences (`/admin/store/:id/state`). |

## Three tasks for the core team

1. **Store data.** Load `data/agco-register.csv` (2,637 rows; **1,881 `Authorized to Open`**) into the stores table, status field exact. Acceptance test: HQ search "Sessions" → 50 locations, all Authorized. (Dev currently shows 8 / "Application in progress".)
2. **Receive signups.** One endpoint that accepts the envelope above (or a nightly poll of `/api/core-export`). Upsert by licence.
3. **Claim button.** On every unclaimed store page in the marketplace and HQ, link **"Claim this listing"** → `https://onboarding.poof.ca/s/<licenseNumber>`. Nothing else routes into onboarding.

Everything else on the onboarding epic (admin list, failed payments, POS sync, manual go-live) is covered by Stripe + `/api/activate` until there are live paying stores.

## Env (Vercel → poofonboarding)
| Var | Purpose |
|---|---|
| `CORE_WEBHOOK_URL` | core endpoint for push (unset = push off, pull still works) |
| `CORE_WEBHOOK_SECRET` | shared HMAC secret |
| `ADMIN_KEY` | already set; also guards `/api/core-export` |
