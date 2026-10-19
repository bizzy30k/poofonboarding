# Retailer onboarding — parity spec for the core team

**Goal:** bring the core-integrated onboarding (Cloud Run, `dev-core`) to the behaviour of the reference build at **poofonboarding.vercel.app** (repo `bizzy30k/poofonboarding`, public), then put it on **onboarding.poof.ca**. The reference is the spec: anything ambiguous below, open the reference and match it.

Each item has an **acceptance test**. A ticket is done when the test passes on a deployed environment, not when the code is merged.

---

## 0. Before anything else — environment

| # | Task | Acceptance test |
|---|---|---|
| 0.1 | Point the app at **production core** (`api.poof.ca`), not `dev-core`. Keep a staging deploy on dev-core. | Network tab on the deployed app shows only `api.poof.ca` calls. |
| 0.2 | Stripe **live** keys. Use a **restricted** key: Customers, SetupIntents, PaymentMethods, Subscriptions, PromotionCodes, Search — write; nothing else. | `pk_live_…` in the page; `sk_test` nowhere. |
| 0.3 | All env/secrets in the deploy config, none in the repo. Run a secret scan over git history. | `git log -p \| grep -E 'sk_live\|SG\.\|pk_' ` returns nothing. |

---

## 1. Store data (the bug Bazif hit)

| # | Task | Acceptance test |
|---|---|---|
| 1.1 | Load the AGCO register into core's `stores` with **`Store Application Status` exact**. Source file: `data/agco-register.csv` in the reference repo (2,637 rows). Dedupe on licence — there are 25 duplicate rows. | HQ search "Sessions" → **50** locations, all `Authorized to Open`. Total authorized = **1,856**. |
| 1.2 | Onboarding only offers stores with status `Authorized to Open`. Anything else → waitlist capture (email + "we'll reach out when you're authorized"). | `/s/CRSA1211680` (Baker & Blazer, authorized) → proceeds. A cancelled licence → waitlist. |
| 1.3 | Chain grouping: group stores by operator name so a retailer sees "Sessions Cannabis — 50 locations" and ticks the ones they own. Reference logic: `scripts/build-data.js` (name normalisation + heuristics). | Search "sessions" → one chain card, 50 doors. "The We Store" → 9. |
| 1.4 | Monthly refresh of the AGCO register (cron or manual script). New authorized stores appear; cancelled ones drop out. | Documented command; run it once and diff. |

---

## 2. Entry points & URLs

| # | Task | Acceptance test |
|---|---|---|
| 2.1 | **Per-store deep link** `onboarding.poof.ca/s/<CRSA>` opens with that store pre-selected and its chain loaded. This is what every outreach email and marketplace button links to. | `/s/CRSA1537578` → "Sessions Cannabis – Amherstburg is already on Poof", chain of 50 loaded. |
| 2.2 | **Resume link** `onboarding.poof.ca/r/<token>` restores an in-progress signup (store, locations, systems, owner) on any device. Token is signed (HMAC), expires in 30 days, contains no secrets. | Start a signup, take the resume link from the Klaviyo event, open in incognito → lands at the same step. |
| 2.3 | **Clean URLs** — no `.html`, no trailing slashes (Bazif's standing rule). | `/s/…`, `/r/…`, `/` only. |
| 2.4 | **"Claim this listing"** button on every unclaimed store page in the marketplace (poof.ca) and in HQ → `onboarding.poof.ca/s/<CRSA>`. | Click from a store page → correct store pre-selected. |

---

## 3. The flow (match the reference step for step)

Steps and copy: open the reference and mirror it. Specifics that matter:

| # | Task | Acceptance test |
|---|---|---|
| 3.1 | **Step 1 Store** — confirm store; "Not my store" → search by name / address / postal / CRSA. | Search "N9V 3G5" finds Amherstburg. |
| 3.2 | **Email capture immediately after store confirm** (name + email), before locations. This is what makes an abandon recoverable. Fires `Onboarding Started` to Klaviyo (see §6). | Enter email, close tab → Klaviyo profile exists with `stage: started` and a `resume_url`. |
| 3.3 | **Step 2 Locations** — multi-select from the chain, "select all", optional regional groups, "add a store under a different name" (franchisees with 2 brands). | Pick 3 of 50, group 2 as "Windsor" → review shows 3 doors, 1 group. |
| 3.4 | **Step 3 Systems** — POS (Cova/Greenline/Blaze/Dutchie POS/Tendy/Other+free text), processor (Merrco/Moneris/Clover/Other), e-commerce (Dutchie/Breadstack/Buddi/None/Other), delivery yes/no + software (Canfleet/Onfleet/In-house/Other). **"Other" free text must be accepted** (≤60 chars). | Choose Other → "Square" → saved and shown in HQ. |
| 3.5 | **Step 4 Review** — editable record panel on the right (store, AGCO status, locations, systems, owner, price `n × $50/mo + HST`). Any field correctable. | Change phone → record updates. |
| 3.6 | **Step 5 Agreement** — click-wrap: full name + title + two checkboxes ("I agree", "I'm authorised"). Record **name, title, timestamp, IP, user-agent, terms version, terms hash**. Terms at `business.poof.ca/terms`. | Record in HQ shows all 7 fields. |
| 3.7 | **Card step** — Stripe **SetupIntent** (vault card, charge nothing). Two paths: **Add card** (→ launch offer) or **Skip — I'll ask on the call**. Skipping is allowed; standard pricing. | Add card → `setupIntent.status = succeeded`, card on customer as default. Skip → customer exists, no card, flagged "collect on call". |
| 3.8 | **Launch offer**: 3 months free (promo `LAUNCH3`, coupon 100% × 3 months) **only if a card is added during signup**, offer ends **2026-12-31**, no location cap. Applied at go-live, not at signup. | Card added before Dec 31 → `offer: LAUNCH3` on record. Skip card → no offer. |
| 3.9 | **Success** — "You're in." + confetti, 5-step "what happens next" list, buttons: Download order form · Preview my coverage (map) · Open business.poof.ca. | Visual match to reference. |
| 3.10 | **Order Form PDF** — generated at acceptance, emailed and downloadable from a signed, **expiring (90-day)** link. Schedule C lists every licence. Unicode-safe (accents, emoji don't crash it). | Name "Nguyễn" → PDF renders. Link after 90 days → 403. |
| 3.11 | **Coverage map** — Leaflet + MapTiler, one circle per location. MapTiler key **origin-restricted** to onboarding.poof.ca. | Map renders; key doesn't work from another origin. |
| 3.12 | **No personal names in customer-facing copy.** Contact is `contact@poof.ca`. Calendly link `calendly.com/baz-poof/30min` only on the "Book a call" button. | grep the bundle for "Bazif"/"Baz" → none. |

---

## 4. Records & Stripe (the join key)

| # | Task | Acceptance test |
|---|---|---|
| 4.1 | **One Stripe customer per signup**, created at the agreement step (before card/skip). `metadata.source = onboarding.poof.ca`, store name, location count, CRSA list, stage. | Stripe customer visible with metadata after step 5. |
| 4.2 | **Stripe customer id (`cus_…`) stored on the core retailer/store record** and on every location. This is the cross-platform key (customer, not subscription — subscriptions don't exist until go-live). | HQ store → `stripeCustomerId` populated. |
| 4.3 | **Write-once acceptance.** Once accepted, the record can't be re-accepted or reset by the public flow. A retry of the same accept returns the existing result (idempotent). | POST accept twice → second returns the same `acceptedAt`, one email. |
| 4.4 | **Franchise guard.** Before accepting, check whether any selected CRSA is already on another retailer's signup; flag it. At go-live, **refuse** doors already live elsewhere unless an admin forces. Must compare full location lists (not a truncated field) and must ignore the same owner's earlier attempts. | Second owner picks a door already signed → flagged. Same email retrying → not flagged. |
| 4.5 | **Go-live (admin)** creates ONE subscription, `quantity = locations`, price `price_1U4PwmPLaXlBkTYFxqt7V0HT` ($50/mo), `automatic_tax`, promo priority: referral code → LAUNCH3 → none. Idempotent (second call updates quantity). Sets core `isActive = true`. | Activate → subscription in Stripe, HQ store active. |
| 4.6 | **Referral/promo codes** — validate against Stripe before accepting; only honour codes on an allow-list (coupon metadata `audience=retailer-referral`). `LAUNCH3` must not be typeable as a referral. | Type `LAUNCH3` → rejected. |

---

## 5. Email (SendGrid)

Provider: **SendGrid**, from `Poof <contact@poof.ca>` (poof.ca already authenticated there). Restricted API key, **Mail Send only**.

| # | Task | Acceptance test |
|---|---|---|
| 5.1 | **Welcome email** at acceptance: "You're in, {first name}" + Order Form PDF attached + summary table + "what happens next" + download link. Reply-to `contact@poof.ca`. Template: `lib/mail.js → retailerHtml()` in the reference. | Email received with PDF. |
| 5.2 | **Internal notification** to `onboarding@poof.ca` on every signup: store, doors, groups, contact, systems, acceptance details, card on file y/n, offer, franchise conflicts, Stripe ids, order-form link. Same provider — **no Web3Forms / third-party relay**. | Email received. |
| 5.3 | **Email verification on skip-card** (recommended): if the retailer skips the card, send a 6-digit code; acceptance/PDF/record only after they enter it. Card-added signups skip this (the card is the proof). | Skip card → code email → enter → "You're in". Wrong code ×5 → locked 10 min. |
| 5.4 | Hard **timeouts** on every outbound call (5 s). A slow SendGrid must not hang the signup. | Block SendGrid → signup still completes, email failure logged. |

---

## 6. Klaviyo (retargeting) — keep what's already live

The Klaviyo flow **"Retailer onboarding — abandoned signup"** is live now and keyed on these events. The new app must emit the **same event names and properties** or the flow silently stops.

| # | Task | Acceptance test |
|---|---|---|
| 6.1 | Fire **`Onboarding Started`** via Klaviyo Events API at every step after email capture, with properties: `stage` (`started \| locations \| systems \| review \| agreement`), `store`, `chain`, `entry_store`, `locations` (count), `resume_url`, `first_name`. Profile: `email`, `first_name`, `properties.retailer = true`, `properties.store`. | Event appears in Klaviyo with all 7 properties. |
| 6.2 | Fire **`Onboarding Completed`** at acceptance (same props, `stage: completed`). This is the flow's exit condition. | Complete a signup → profile exits the flow. |
| 6.3 | Fire **`Onboarding Waitlist`** for non-authorized stores. | Waitlist capture → event. |
| 6.4 | Use the **same Klaviyo private key / integration source** so the metrics are the existing `Onboarding Started` (`TfdJen`) and `Onboarding Completed` (`RSEnsa`) — Klaviyo treats a different integration source as a different metric and the flow won't see it. Easiest: send from the server via the Events API with the account's private key, not via a new integration. | Events land on the existing metric ids, not new ones. |
| 6.5 | **`Call Booked`** exit is handled by the existing Zapier zap (Calendly → Klaviyo). Nothing to build. | — |

---

## 7. Security (findings from the independent audit of the reference — apply the same to yours)

| # | Task | Acceptance test |
|---|---|---|
| 7.1 | **Cloudflare Turnstile** (Managed mode, invisible) on the email step; server-side `siteverify` before creating a Stripe customer and before the first Klaviyo event. Widget hostnames: `onboarding.poof.ca` + staging. | POST without a token → 403. |
| 7.2 | **Session token**: the browser gets an HMAC-signed token when its Stripe customer is created; every later update/accept must present it. A `cus_` id alone (they're in emails) must not be enough to edit a record. | POST accept with a known `cus_` but no token → 403. |
| 7.3 | **No `/admin/*` endpoints callable from the public page** without auth. (Current dev build calls `/admin/store/list-unclaimed` from the browser.) Public reads go through a public, read-only endpoint that returns only name/address/CRSA/status. | Unauthenticated call to any `/admin/` route → 401. |
| 7.4 | **Admin endpoints** (go-live, exports, link lists): key in a header only (never query string), constant-time compare, rate-limited. | `?key=` → 401. |
| 7.5 | **Server-side validation** on every POST body: types, max lengths, email format, CRSA format, enum/free-text rules. Client `maxlength` mirrors server. | Oversized / wrong-type fields → 400 with field names. |
| 7.6 | **Rate limits**: per-IP and per-email on email capture / lead events; per-IP on customer creation; global cap on any paid API (Google Places). Prefer Cloudflare/edge rules over in-process counters. | 50 rapid POSTs → 429. |
| 7.7 | **Same-origin check** on POSTs (Origin/Referer), tolerant of missing/malformed Referer. | Cross-origin POST → 403; privacy-extension user → works. |
| 7.8 | **Signing secret** for resume/order-form/session tokens is its **own** secret (not derived from Stripe), ≥32 chars, app refuses to start in prod without it. Tokens: full-length HMAC, `timingSafeEqual`, purpose-prefixed (`resume:`, `orderform:`, `session:`). | Unset secret → boot fails. |
| 7.9 | **Headers**: CSP (allow Stripe, Turnstile, GTM, MapTiler, fonts), HSTS, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`. `noindex` on API routes. | securityheaders.com → A. |
| 7.10 | **XSS**: every user- or AGCO-sourced string escaped before DOM insertion; `href`s whitelisted to `https?:`; map tooltips escaped. | Store name `<img onerror>` renders as text. |
| 7.11 | **PII**: never log full error objects or request bodies; never store other customers' emails in a record (franchise conflicts carry ids + counts only); resume token never reaches analytics (`replaceState` before GA loads). | GA `page_location` never contains `/r/`. |
| 7.12 | **Stripe client**: timeout 8 s, 1 retry (Stripe's default 80 s exceeds serverless limits). | — |
| 7.13 | **Tests** covering 7.1–7.8 run in CI on every PR. Reference: `test/security.test.js` (19 tests, `npm test`). | CI green. |

---

## 8. Analytics

| # | Task | Acceptance test |
|---|---|---|
| 8.1 | GA4 property `G-DDVX27NB26`. Events: `onb_view`, `onb_email`, `onb_locations`, `onb_systems`, `onb_review`, `onb_terms`, `onb_card_saved`, `onb_card_skipped`, `onb_complete`, `onb_resume`, with `store`, `locations`, `entry` (`link \| search`) params. | Events visible in GA4 DebugView. |

---

## 9. Hand-off from the reference build (what you can lift directly)

All in `bizzy30k/poofonboarding` (public):

- `data/agco-register.csv`, `data/stores.json`, `data/core-stores.json` — the authorized list and the core-shaped documents
- `scripts/import-agco.js`, `scripts/build-data.js` — status filter, dedupe, chain grouping heuristics
- `public/index.html` — the full flow and copy (vanilla JS; port the copy and step order, not the code)
- `lib/orderform.js` — Order Form PDF layout
- `lib/mail.js` — welcome + internal email templates
- `lib/security.js` — rate limit, session token, Turnstile verify, validation helpers
- `lib/core.js` — mapping from a signup to core's store document (field names already match `GET /admin/store/:id`)
- `test/security.test.js` — attack-path tests to port
- `handover/terms.html` — canonical terms copy for hashing

## 10. Launch checklist

1. §0 env + §1 data pass their tests on staging
2. Full walkthrough on staging: deep link → email → 3 locations → systems (incl. "Other") → agreement → **add card** → You're in → PDF received → Klaviyo shows Started + Completed → Stripe customer with card → HQ store has `stripeCustomerId`
3. Same walkthrough with **skip card** → verification code → You're in → HQ flagged "collect on call"
4. Abandon at step 3 → Klaviyo email 1 arrives after 1 h with a working resume link
5. Security tests (§7) green in CI; `securityheaders.com` A
6. DNS: `onboarding` CNAME → Cloud Run; HTTPS; `/s/CRSA1537578` resolves
7. Marketplace "Claim this listing" buttons point at the new domain
8. Retire `poofonboarding.vercel.app` (redirect `/s/*` and `/r/*` to the new domain for 90 days so emailed links keep working)
