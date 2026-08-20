# Developer task list — Poof retailer onboarding

Everything needed to take the onboarding flow from this zip to live traffic at
**business.poof.ca/join/**.

Ordered by dependency — later phases fail if earlier ones are skipped. Phases 1–6
are roughly a day if the accounts already exist; most of the elapsed time is DNS
propagation and Stripe/Google verification, so start Phase 0 first and work on
Phase 1 while those settle.

A handful of items need Bazif rather than you. They're marked **[Bazif]** and
noted at the end.

---

## Phase 0 — Accounts and access

Create the keys yourself in each dashboard rather than having them passed to you
in chat or Slack. `STRIPE_SECRET_KEY` and `ADMIN_API_KEY` can both move money.

- [ ] Owner or admin on the **Vercel** project hosting business.poof.ca
- [ ] Access to **Cloudflare/GoDaddy DNS** for poof.ca
- [ ] **Stripe** dashboard access — account `acct_1U4NCWPLaXlBkTYF` (Poof Technologies Inc.)
- [ ] **Google Cloud** — create or join a project
- [ ] **Resend** account (resend.com) for transactional email
- [ ] Access to the repo for **business.poof.ca**
- [ ] Confirm `baz@poof.ca` exists and can send — every reply and order form routes there

---

## Phase 1 — Get the code deployed

### 1.1 Merge into the existing site — **same Vercel project**

The flow calls `/api/lookup`, `/api/checkout`, `/api/geocode` as **same-origin
relative paths**. A separate origin means every call fails CORS. This is the one
architectural decision that can't be worked around later.

```
business.poof.ca repo/
  index.html  retailers.html  brands.html  integrations.html   ← existing
  get-started.html          ← new split page (from handover/)
  join/index.html           ← the flow (public/index.html)
  api/                      ← 6 routes, copy across
  lib/                      ← copy across
  data/                     ← AGCO CSV + built index
  scripts/
  package.json              ← merge deps: stripe, pdf-lib
  vercel.json               ← merge functions block, keep includeFiles: "data/**"
```

If business.poof.ca isn't on Vercel, keep this as its own deployment and proxy
`business.poof.ca/join/*` and `/api/*` to it. Same-origin from the browser is the
requirement, not Vercel specifically.

- [ ] Files merged
- [ ] `package.json` dependencies merged (`stripe`, `pdf-lib` — that's all)
- [ ] `vercel.json` functions block merged, including `includeFiles: "data/**"`
      *(without it the store lookup returns empty results in production)*

### 1.2 Build the store index

```bash
npm install
npm run build:index
```

- [ ] Produces `data/retailers.json` — should report **2,611 stores, 1,024 banners**
- [ ] **Commit `data/retailers.json`** — the functions read it from disk at runtime
- [ ] Note: rebuild whenever a fresh AGCO export is dropped into `data/`. Monthly is plenty.

### 1.3 First deploy

- [ ] `vercel --prod`
- [ ] `/join/` loads
- [ ] Typing `crown leaf` returns results *(if empty → `includeFiles` or the uncommitted index)*

---

## Phase 2 — Stripe

Product, price, coupon and promo codes already exist. Don't recreate them.

| | |
|---|---|
| Product | `prod_V4WwQNpKS1WYXo` — Retail Ad Network |
| Price | `price_1U4PwmPLaXlBkTYFxqt7V0HT` — CAD $50.00 per location/month, **tax_behavior exclusive** |
| Coupon | `mKwuq2u8` — 100% off, repeating 3 months, scoped to the product |
| Promo codes | `BUZZD` (Buzz'd) · `SENSE` (Sense & Purpose) · `UFEELU` (Ufeelu) |
| Stripe Tax | Active, Toronto head office |

- [ ] Copy the **live secret key** (`sk_live_…`) from dashboard.stripe.com/apikeys
- [ ] Copy the **live publishable key** (`pk_live_…`) — this one goes to the browser for embedded Checkout
- [ ] Create the webhook endpoint:
      - URL `https://business.poof.ca/api/webhook`
      - Events: `checkout.session.completed`, `customer.subscription.deleted`
      - Copy the `whsec_…` signing secret
- [ ] Generate the admin key: `openssl rand -hex 32`

**How billing works** — Checkout runs in **embedded setup mode**. It vaults a card
and creates nothing billable. The subscription is created later by
`POST /api/activate`, which is what starts billing and applies the referral coupon
from that date. That's what makes "nothing charged until you go live" true.

---

## Phase 3 — Email (Resend)

- [ ] Create a Resend account and an API key
- [ ] **Verify the `poof.ca` domain** — add the SPF and DKIM records to DNS
- [ ] Wait for verification to go green before testing
      *(unverified → mail lands in spam, and the welcome email carries the order form)*

Two emails fire automatically when a card is vaulted:

| Email | From | To | Contains |
|---|---|---|---|
| Welcome | `baz@poof.ca` | retailer, reply-to Bazif | next steps, the shelf ask, call booking link, order form PDF, "nothing charged" |
| Order form | `baz@poof.ca` | `baz@poof.ca` | full record in the body + PDF, next-steps block naming their integration partners |

The follow-up after the call stays manual by design — the required-items list differs per POS.

- [ ] Confirm `baz@poof.ca` receives both the replies and the internal order forms

---

## Phase 4 — Google

### 4.1 Places API

Used for store hours, phone, website, and street-level map pins.

- [ ] Enable the **Places API** in Google Cloud
- [ ] Create an API key
- [ ] Restrict it to the Places API and your domain
- [ ] Set a billing budget/alert — it's per-request

### 4.2 Sheets (the growing store record)

- [ ] Enable the **Google Sheets API**
- [ ] Create a **service account**, download the JSON key
- [ ] Upload `Poof-Retailer-Onboarding-Tracker.xlsx` to Drive, open as a Google Sheet
- [ ] Copy the sheet id from the URL
- [ ] **Share the sheet with the service account's `client_email` as an Editor**
      *(fails silently if missed — rows just never appear)*
- [ ] Delete the example row (row 4) once real data lands

The tracker writes one row per store, 31 columns, keyed on submission ID so
webhook retries update in place rather than duplicating. `lib/tracker.js` signs
its own JWT — no `googleapis` dependency.

**Column order is a contract.** `TRACKER_COLUMNS` in `lib/tracker.js` and the
header row must match; `scripts/build-tracker.py` reads the list straight out of
the JS so they can't drift. Add new columns at the end, in both.

---

## Phase 5 — Storage

- [ ] Vercel → Storage → Create → **KV** → attach to the project
      *(adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` automatically)*

Without KV a signup lives in server memory and won't survive the gap between the
card form and Stripe's webhook — a completed signup with no order form, no email
and no tracker row. **Required before real traffic.**

---

## Phase 6 — Environment variables

Vercel → Settings → Environment Variables. Tick Production, Preview and
Development. Mark ✅ rows **Sensitive**.

| Name | Value | Secret |
|---|---|---|
| `STRIPE_SECRET_KEY` | `sk_live_…` | ✅ |
| `STRIPE_PUBLISHABLE_KEY` | `pk_live_…` | |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` | ✅ |
| `STRIPE_PRICE_AD_NETWORK` | `price_1U4PwmPLaXlBkTYFxqt7V0HT` | |
| `STRIPE_REFERRAL_COUPON` | `mKwuq2u8` | |
| `ADMIN_API_KEY` | generated hex | ✅ |
| `PUBLIC_BASE_URL` | `https://business.poof.ca` (no trailing slash) | |
| `ONBOARDING_BASE_PATH` | `/join` | |
| `DASHBOARD_URL` | `https://business.poof.ca` | |
| `RESEND_API_KEY` | `re_…` | ✅ |
| `WELCOME_EMAIL_FROM` | `Poof <hello@poof.ca>` | |
| `WELCOME_EMAIL_REPLY_TO` | `baz@poof.ca` | |
| `REP_CC_EMAIL` | leave blank — all onboarding routes to Bazif | |
| `ONBOARDING_INBOX` | `baz@poof.ca` | |
| `GOOGLE_PLACES_API_KEY` | Places key | ✅ |
| `KV_REST_API_URL` | from Vercel KV | |
| `KV_REST_API_TOKEN` | from Vercel KV | ✅ |
| `TRACKER_SHEET_ID` | id from the Sheet URL | |
| `TRACKER_SHEET_TAB` | `Onboarded stores` | |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | whole JSON key, one line | ✅ |
| `HUBSPOT_ACCESS_TOKEN` | optional — creates a contact on signup | ✅ |

- [ ] All set
- [ ] **Redeploy** — env vars are injected at build time, saving alone does nothing

---

## Phase 7 — Website wiring

- [ ] Drop `get-started.html` at the site root
- [ ] Drop **`terms.html` at the site root** — the acceptance checkbox links to it,
      and the terms must be readable *before* the retailer ticks the box for the
      click-wrap to hold. If you serve it at a different path, update `TERMS_URL`
      in `public/index.html` to match.
- [ ] Copy `legal/*.docx` to `/legal/` so the "Download as Word documents" link resolves
- [ ] Whenever the terms text changes, bump `TERMS_VERSION` in `public/index.html`
      *(it's stored against every acceptance, so it must identify the exact text shown)*
- [ ] Change the **Get Started** links in nav, hero and footer across
      `index.html`, `retailers.html`, `brands.html`, `integrations.html`
      from `https://calendly.com/lily-poof` → `/get-started.html`
- [ ] Confirm the brand path still lands on `calendly.com/lily-poof`
- [ ] Check the split page against the live site's styling
      *(tokens are sampled from your screenshot; the font is **Outfit**, my best
      guess from the letterforms — swap `--font` if the site loads something else)*

```
Get Started → /get-started.html ─┬─ Retailers → /join/
                                 └─ Brands    → calendly.com/lily-poof
```

---

## Phase 8 — Test before real traffic

Test mode has **separate** keys, products, prices and coupons. The live IDs above
do not exist there.

- [ ] Recreate product, price (**`--tax-behavior=exclusive`**, not optional),
      coupon and promo codes in test mode — commands in `handover/HANDOVER.md` §4.1
- [ ] Point a Vercel **Preview** deployment at test keys; leave Production on live
- [ ] Local webhooks: `stripe listen --forward-to localhost:3000/api/webhook`
      *(use the `whsec_` it prints, not the production one)*

Full pass with card `4242 4242 4242 4242`:

- [ ] `crown leaf` → 8 locations as **one** row, not eight
- [ ] `CRSA1194941` → jumps to that single store and offers to set up just that one
- [ ] Readback: locations, AGCO status, hours in plain English
- [ ] "Change an answer" chip → re-asks, then resumes without losing history
- [ ] Add a store under a different name → already-selected stores are filtered out
- [ ] Card step → **nothing charged**. Verify a Customer and SetupIntent exist, **no PaymentIntent**
- [ ] Welcome email arrives from `baz@poof.ca`, order form PDF attached
- [ ] Order form email arrives at `baz@poof.ca`
- [ ] Row appears in the Google Sheet, columns aligned
- [ ] **Preview my store on the marketplace** → tiles load, pins street-level,
      coverage toggle changes the km² figure
- [ ] Activation:

```bash
curl -X POST https://business.poof.ca/api/activate \
  -H "x-poof-admin-key: $ADMIN_API_KEY" \
  -H "content-type: application/json" \
  -d '{"submissionId":"onb_…","goLiveDate":"2026-09-01"}'
```

- [ ] Subscription created with **quantity = number of locations**, coupon applied,
      **HST on top**. Two locations = $100.00 + $13.00 = $113.00, discounted to $0
      for three months.
      *No tax line → `automatic_tax` or the customer address didn't take.
      Shows $50 → quantity didn't pass.*

---

## Phase 9 — Build next (not in this repo)

Ordered by how much they block.

### 9.1 Admin panel — **on the critical path**

The flow promises it twice and §5 of the service agreement names it as the only
place API credentials are accepted. Until it exists there's no compliant way to
receive Cova/Greenline/Breadstack/Canfleet keys.

Minimum: store details, per-location hours, contact fields, a **credential vault**,
and a go-live button that calls `/api/activate` behind real auth instead of the
shared `ADMIN_API_KEY`.

- [ ] Scope and build

### 9.3 KV durability

Entries expire after 24h. If a Sheet write fails, the signup is lost — failures
currently only log a CSV line to the server console. Extend the TTL and add a
retry, or move the durable record to Supabase (which the admin panel needs anyway).

- [ ] Fix before volume

### 9.4 Batch geocoding

`/api/geocode` resolves exact coordinates via Places for the retailer's own stores
at map time. Everything else uses city centroids from `lib/geo.js` (2,379 of 2,611
mapped by city, 232 by postal region). A one-time batch geocode at build time would
make every pin exact and remove the runtime Places call.

- [ ] Optional improvement

### 9.5 Free-listing claim flow

~1,700 auto-populated stores are listed from public AGCO data with no account.
Needs a "claim your listing" path so an unclaimed store can take ownership of its
own entry. **[Bazif]**

---

## Needs Bazif, not you

- [ ] Confirm the card-step claim *"your setup goes to the front of the queue"* is
      operationally true — if everyone is worked in order, cut that line
- [ ] Decide whether the 108 single-store banners that look like branches of larger
      chains (Spiritleaf ×19, One Plant ×19, Tokyo Smoke ×16) should be merged. They're
      largely franchises with separate licensees, so they're currently kept separate —
      a business call, not a data one.

---

## Reference

| | |
|---|---|
| Routes | `/api/lookup` `/api/checkout` `/api/webhook` `/api/activate` `/api/geocode` `/api/map` |
| Dependencies | `stripe`, `pdf-lib` |
| Build index | `npm run build:index` |
| Rebuild tracker workbook | `npm run build:tracker` |
| Local dev | `npm run dev` |
| Longer reference | `handover/HANDOVER.md` |

**Data lives in four places:** Vercel KV (in-progress, 24h), the Google Sheet (the
growing record), Stripe (customer + subscription metadata), and email.

```
Get Started → split page → /join/ flow
                              ↓ card vaulted (setup mode — no charge)
              webhook fires ├→ welcome email from baz@ (order form PDF)
                            ├→ order form to baz@poof.ca
                            └→ row appended to the Google Sheet
                                   ↓
                     Bazif calls · partner integrations · HQ setup
                                   ↓
                     POST /api/activate → subscription created, billing starts
```
