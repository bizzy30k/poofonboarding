# Poof retailer onboarding — reference

> **Setting it up?** Start with `DEVELOPER-TASKS.md` in the repo root — that's the
> current, ordered, tick-box version. This document is the longer reference behind it.

Everything needed to get the flow live at `business.poof.ca/join/` and split the
**Get Started** button on `business.poof.ca`.

Two people are involved:

- **Bazif** does Part 1 — the secrets. Nobody else needs to see them.
- **The dev team** does Parts 2–4 — deploy, DNS, website button, testing.

Work in that order. Part 2 will fail without Part 1.

---

## Before you start — read this once

**Secret keys never go in the repo.** `STRIPE_SECRET_KEY` can move money. It goes
in Vercel's environment variables and nowhere else — not in a file, not in Slack,
not in a ticket, not in a chat with a vendor. If one is ever pasted somewhere
shared, roll it in the Stripe dashboard immediately; a rolled key is a five-minute
inconvenience, a leaked one is not.

**Test mode and live mode are separate universes.** Keys, products, prices,
coupons and promotion codes all exist twice and never cross over. The live IDs in
this guide (`price_1U4Pwm…`, coupon `mKwuq2u8`, codes `BUZZD` / `SENSE` /
`UFEELU`) exist **only in live mode**. To test with fake cards, the same objects
have to be created again in test mode — see Part 4.

---

## Part 1 — Bazif: add the secrets to Vercel

Do this yourself. It takes about ten minutes.

### 1.1 Get the Stripe secret key

1. Go to **https://dashboard.stripe.com/apikeys**
2. Confirm the **Test mode** toggle, top right, is **OFF** (you want live for now)
3. Under *Secret key*, click **Reveal live key** and copy it — starts `sk_live_`

Don't paste it into anything except step 1.3.

### 1.2 Create the webhook and get its signing secret

1. Go to **https://dashboard.stripe.com/webhooks**
2. **Add endpoint**
3. Endpoint URL: `https://business.poof.ca/api/webhook`
4. Under *Select events*, tick exactly these two:
   - `checkout.session.completed`
   - `customer.subscription.deleted`
5. **Add endpoint**
6. On the endpoint's page, find **Signing secret** → **Reveal** → copy it — starts `whsec_`

If `business.poof.ca/join/` isn't live yet, create the endpoint anyway. Stripe will retry
failed deliveries for up to three days, so nothing is lost.

### 1.3 Add the variables in Vercel

**Vercel → your project → Settings → Environment Variables.**

For each row: paste the **Name** exactly as written, paste the value, tick
**Production**, **Preview** and **Development**, tick **Sensitive** where noted,
then **Save**.

| Name | Value | Sensitive |
|---|---|---|
| `STRIPE_SECRET_KEY` | the `sk_live_…` key from 1.1 | ✅ |
| `STRIPE_WEBHOOK_SECRET` | the `whsec_…` secret from 1.2 | ✅ |
| `STRIPE_PRICE_AD_NETWORK` | `price_1U4PwmPLaXlBkTYFxqt7V0HT` | — |
| `STRIPE_REFERRAL_COUPON` | `mKwuq2u8` | — |
| `PUBLIC_BASE_URL` | `https://business.poof.ca` (no trailing slash) | — |
| `ONBOARDING_BASE_PATH` | `/join` | — |
| `STRIPE_PUBLISHABLE_KEY` | `pk_live_…` from the same API keys page | — |
| `DASHBOARD_URL` | `https://business.poof.ca` | — |
| `ADMIN_API_KEY` | a long random string you generate | ✅ |
| `RESEND_API_KEY` | from resend.com → API Keys | ✅ |
| `WELCOME_EMAIL_FROM` | `Poof <hello@poof.ca>` | — |
| `WELCOME_EMAIL_REPLY_TO` | `retail@poof.ca` | — |
| `KV_REST_API_URL` | from Vercel KV, see 1.4 | — |
| `KV_REST_API_TOKEN` | from Vercel KV, see 1.4 | ✅ |
| `GOOGLE_PLACES_API_KEY` | Google Cloud → Places API | ✅ |
| `TRACKER_SHEET_ID` | the id in your Google Sheet's URL | — |
| `TRACKER_SHEET_TAB` | `Onboarded stores` | — |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | the whole service-account JSON, one line | ✅ |
| `HUBSPOT_ACCESS_TOKEN` | optional — HubSpot private app token | ✅ |

For `ADMIN_API_KEY`, generate rather than invent one:

```bash
openssl rand -hex 32
```

This key starts billing when called, so treat it like the Stripe key.

**Environment variable changes only take effect on the next deploy.** After
saving, redeploy — see 2.4.

### 1.4 Vercel KV (required before real signups)

**Vercel → Storage → Create → KV**, attach it to the project. Vercel adds
`KV_REST_API_URL` and `KV_REST_API_TOKEN` automatically; if it does, skip those
two rows above.

Without KV, a signup lives in server memory and will not survive the gap between
the retailer entering their card and Stripe's webhook arriving. That means a
completed signup with no order form, no welcome email and no tracker row. Fine
for a smoke test, not for real retailers.

---

## Part 2 — Dev team: deploy the flow

### 2.1 Repo

The project is a static front end plus Vercel serverless functions. No build step,
no framework.

```
public/index.html        the entire chat UI
api/lookup.js            typeahead + AGCO/Places enrichment
api/checkout.js          Stripe Checkout, setup mode — vaults a card, charges nothing
api/webhook.js           card vaulted → order form PDF → welcome email → tracker
api/activate.js          ops only: starts billing (needs ADMIN_API_KEY)
lib/                     enrichment, vendors, order form, tracker, email, store
scripts/build-index.mjs  AGCO CSV → searchable retailer index
data/                    AGCO export + built index (commit both)
```

### 2.2 Build the retailer index

```bash
npm install
npm run build:index
```

Writes `data/retailers.json` — 2,611 stores, 1,024 banners. **Commit it.** The
serverless functions read it from disk at runtime; it is not fetched.

Rebuild whenever a fresh AGCO export is dropped into `data/`. Monthly is plenty.

### 2.3 Deploy

```bash
vercel --prod
```

`vercel.json` already sets `includeFiles: "data/**"` so the index is bundled into
the functions. Without that the lookup returns empty results — if typeahead finds
nothing after a deploy, check that first.

### 2.4 Redeploy after any env var change

Vercel → Deployments → latest → **⋯** → **Redeploy**. Env vars are injected at
build time; saving them is not enough on its own.

### 2.5 Hosting — same origin as business.poof.ca

The flow is **not** a subdomain. It lives at a path on the existing site:

| | |
|---|---|
| Split page | `https://business.poof.ca/get-started.html` |
| Onboarding flow | `https://business.poof.ca/join/` |
| API | `https://business.poof.ca/api/*` |

**This has to be the same Vercel project as the rest of business.poof.ca.** The
flow calls `/api/lookup` and `/api/checkout` as same-origin relative paths — if
the API sits on a different origin, every call fails CORS.

Merge like this:

```
business.poof.ca repo/
  index.html                 existing
  retailers.html             existing
  brands.html                existing
  integrations.html          existing
  get-started.html           ← new split page
  join/
    index.html               ← the onboarding flow
  api/                       ← from this repo, unchanged
  lib/                       ← from this repo, unchanged
  data/                      ← from this repo, commit retailers.json
  scripts/
  package.json               merge dependencies: stripe, pdf-lib
  vercel.json                merge the functions block
```

If business.poof.ca is hosted somewhere other than Vercel, the alternative is a
rewrite: keep this project deployed separately and proxy
`business.poof.ca/join/*` and `business.poof.ca/api/*` to it. Same origin from the
browser's point of view, so no CORS. Same-origin is the requirement, not Vercel.

Set `PUBLIC_BASE_URL=https://business.poof.ca` (no trailing slash) and
`ONBOARDING_BASE_PATH=/join`. Stripe's return URL is built from both.

### 2.6 Email sending domain

In Resend, verify `poof.ca` and add the DNS records it asks for (SPF, DKIM).
Unverified domains land in spam, and the welcome email carries the order form, so
this is worth doing before launch rather than after.

---

## Part 3 — Dev team: split the Get Started button

Two files, and the routing is now a three-step chain rather than a direct link:

```
Get Started  →  /get-started.html  →  ┬─ Retailers → /join/  (the flow)
   (nav, hero, footer)                └─ Brands    → calendly.com/lily-poof
```

**`handover/get-started.html`** — the split page. Drop it in at the site root. It
matches the existing nav, footer and page structure, and both cards carry the copy
you asked for: *list your store · about two minutes* for retailers, *book a call
with our team · 20 minutes* for brands.

**Change the existing Get Started links** — in the nav, hero, and footer of
`index.html`, `retailers.html`, `brands.html` and `integrations.html` — from
`https://calendly.com/lily-poof` to `/get-started.html`. Brands still reach
Calendly, just one step later, after they've identified themselves.

**`handover/get-started-split.html`** is the earlier inline-chooser variant, kept
in case you'd rather have the choice happen in a modal than on its own page. Use
one or the other, not both.

**Two variants, both included:**

- **Variant A — two buttons.** For the hero, where there's room. Retailers get the
  primary magenta button, brands the outlined one.
- **Variant B — one button, opens a chooser.** For the nav and footer. Add
  `data-poof-cta` to any existing button and the script handles the rest, so you
  don't have to restyle anything.

Lily's Calendly is `https://calendly.com/lily-poof` — already wired in, taken from
the existing Get Started links on the live site. Nothing to replace.

**Routing:**

| Choice | Goes to |
|---|---|
| Retailers | `https://business.poof.ca/join/` — the new flow |
| Brands | Lily's Calendly, new tab |

The script pushes a `poof_cta_choice` event to `dataLayer` and a HubSpot event on
each choice, so you can see the retailer/brand split in analytics. Delete that
block if you don't want it.

The chooser uses a native `<dialog>`, so it's keyboard-accessible and needs no
library. Browsers without `showModal` fall back to sending the visitor straight
to the retailer flow.

---

## Part 4 — Testing

### 4.1 Test mode first

The live price, coupon and promotion codes **do not exist in test mode**. Before
testing with fake cards, recreate them there:

```bash
stripe products create \
  --name="Retail Ad Network" --unit-label=location \
  --tax-code=txcd_10103001

stripe prices create \
  --product=<test_product_id> \
  --currency=cad --unit-amount=5000 \
  --recurring[interval]=month \
  --tax-behavior=exclusive \
  --lookup-key=retail_ad_network_monthly

stripe coupons create \
  --percent-off=100 --duration=repeating --duration-in-months=3 \
  --name="Brand referral - 3 months free" \
  --applies-to[products][]=<test_product_id>

stripe promotion_codes create --coupon=<test_coupon_id> --code=BUZZD
```

`--tax-behavior=exclusive` is not optional. It cannot be changed after the price
is created, and getting it wrong is why the first live price had to be replaced.

Then point a Vercel **Preview** deployment at the test keys and test there,
leaving Production on live keys.

### 4.2 Local webhook testing

```bash
stripe listen --forward-to localhost:3000/api/webhook
npm run dev
```

`stripe listen` prints its own `whsec_` — use that one locally, not the
production secret.

### 4.3 End-to-end pass

Test card `4242 4242 4242 4242`, any future expiry, any CVC.

1. Open the flow, type `pops` — the typeahead should return **Pop's Cannabis Co.**
   as one row with a location count, not 44 rows
2. Confirm the readback: locations, AGCO status, hours in plain English
3. Pick two locations
4. POS → Greenline, processor → Merrco, Breadstack → yes
5. Delivery → yes → Canfleet
6. Referral code `BUZZD` — should validate
7. Owner details, then the summary
8. Card → the Stripe form. **Nothing should be charged.** Confirm in the
   dashboard that a Customer and a SetupIntent exist and no PaymentIntent does
9. Check the welcome email arrives with the order form PDF attached, showing
   2 × $50.00
10. Check a row appears in the tracker sheet
11. Start billing:

```bash
curl -X POST https://business.poof.ca/api/activate \
  -H "x-poof-admin-key: $ADMIN_API_KEY" \
  -H "content-type: application/json" \
  -d '{"submissionId":"onb_…","goLiveDate":"2026-09-01"}'
```

12. Confirm the subscription is created with **quantity 2**, the referral coupon
    applied, and HST added on top — $100.00 + $13.00 = $113.00, discounted to
    $0.00 for three months

If step 12 shows $100.00 with no tax line, `automatic_tax` or the customer's
address didn't take. If it shows $50.00, quantity didn't pass.

---

## What is not built yet

Be explicit with the team about these — they're known gaps, not bugs.

| Gap | Impact |
|---|---|
| **Admin panel** | The flow promises it twice and the agreement names it as the only place API credentials are accepted. Needs: store details, per-location hours, contact fields, a credential vault for POS/Breadstack/Canfleet, and a go-live button that calls `/api/activate`. |

| **Free-listing claim flow** | ~1,700 auto-populated stores are listed from public AGCO data with no account. Needs a claim path. |
| **Terms page** | `terms.html` must be live before the first real signup — the acceptance checkbox links to it. |

---

## Reference — live Stripe objects

Verified against the account on 14 Aug 2026.

| | |
|---|---|
| Account | `acct_1U4NCWPLaXlBkTYF` — Poof Technologies Inc. |
| Product | `prod_V4WwQNpKS1WYXo` — Retail Ad Network, tax code `txcd_10103001`, unit label `location` |
| Price | `price_1U4PwmPLaXlBkTYFxqt7V0HT` — CAD $50.00, per unit, monthly, **tax_behavior exclusive**, lookup key `retail_ad_network_monthly` |
| Archived price | `price_1U4NsyPLaXlBkTYFRfu7Fl0y` — do not use, tax behaviour unspecified |
| Coupon | `mKwuq2u8` — 100% off, repeating 3 months, scoped to the product above |
| Promotion codes | `BUZZD` (Buzz'd) · `SENSE` (Sense & Purpose) · `UFEELU` (Ufeelu) |
| Stripe Tax | Active, head office Toronto ON |
| Statement descriptor | `POOF RETAIL AD NET` |

Quantity on the subscription is the number of Authorized Locations, per §6.3 of
the Dispensary Agreement.
