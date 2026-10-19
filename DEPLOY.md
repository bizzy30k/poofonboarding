# Deploy onboarding.poof.ca — step by step

Same pattern as signup.poof.ca: GitHub → Vercel → Cloudflare CNAME. About 30
minutes, no terminal needed except step 1 if you prefer the GitHub website.

## 1. Push the code to GitHub

Create a new repo `bizzy30k/poof-onboarding` (private). Then either upload
the unzipped folder through the GitHub website ("Add file → Upload files"), or:

```bash
cd poof-onboarding
git init && git add . && git commit -m "Retailer onboarding v2"
git branch -M main
git remote add origin https://github.com/bizzy30k/poof-onboarding.git
git push -u origin main
```

## 2. Import into Vercel

1. vercel.com → **Add New → Project** → import `poof-onboarding`.
2. Framework preset: **Other**. Root directory: leave as `/`. Build command: leave blank. Output directory: leave blank.
3. Before clicking Deploy, open **Environment Variables** and add the ones in step 3.
4. Deploy. You'll get `poof-onboarding.vercel.app`.

## 3. Environment variables (Vercel → Project → Settings → Environment Variables)

Set every one for **Production** (and Preview if you want test deploys).

| Variable | Value | Required |
|---|---|---|
| `STRIPE_SECRET_KEY` | `sk_live_…` from dashboard.stripe.com/apikeys on `acct_1U4NCWPLaXlBkTYF`. Create a **new restricted key** named "onboarding.poof.ca" with write access to Customers, SetupIntents, Subscriptions, Promotion Codes. | Yes |
| `STRIPE_PUBLISHABLE_KEY` | `pk_live_…` from the same page | Yes |
| `ADMIN_KEY` | Run `openssl rand -hex 24` (or any 40+ random characters). Used only by `/api/activate`. | Yes |
| `SITE_URL` | `https://onboarding.poof.ca` | Yes |
| `SENDGRID_API_KEY` | app.sendgrid.com → Settings → API Keys → Create (Restricted: Mail Send = Full Access). poof.ca is already authenticated there, so no DNS. Set `FROM_EMAIL` to an address on the authenticated domain. | For retailer emails + PDF attachment |
| `RESEND_API_KEY` | Alternative to SendGrid (resend.com → API Keys; needs the poof.ca domain verified there). Ignored when SendGrid is set. | Optional |
| `SIGNING_SECRET` | **Required.** 64 random hex chars (`openssl rand -hex 32`). Signs resume links, order-form links and session tokens. Rotating it invalidates every link already sent — set it once, before launch, and never derive it from another key. |
| `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile widget (hostnames: onboarding.poof.ca + poofonboarding.vercel.app, mode Managed). Blocks scripted signups; invisible to real retailers. Without the secret the check is skipped. |
| `WEB3FORMS_KEY` | same key signup.poof.ca uses (copy from that project's Vercel env — not stored in git) — sends the internal notification to onboarding@poof.ca | Recommended |
| `MAPTILER_KEY` | same key as join.poof.ca (copy from Vercel env; restrict it to onboarding.poof.ca in MapTiler) — nicer map tiles. Without it the map falls back to free CARTO tiles. | Optional |
| `GOOGLE_PLACES_KEY` | Google Cloud → APIs → Places API → key. Adds rating, hours, phone to the store record. | Optional |
| `KLAVIYO_API_KEY` | Klaviyo → Settings → API keys → private key with Events + Profiles write. Sends `Onboarding Started` / `Onboarding Completed` events so you can build an abandonment flow (see step 9). | Recommended |
| `SMS_NUMBER` | Your cell in E.164, e.g. `+14165550100`. Shows a "Text Baz" button on the question screen. Leave blank to hide. | Optional |
| `TESTIMONIAL_QUOTE` | Mo's quote, one or two sentences. Shown at the pricing step with `TESTIMONIAL_NAME` (default Mo) and `TESTIMONIAL_STORE` (default The We Store). Hidden until set. | Recommended |
| `RETAILER_COUNT` | e.g. `80+`. Leave blank unless it's true today. | Optional |
| `LAUNCH_OFFER_UNTIL` | Defaults to `2026-12-31`. Change to extend or end the 3-months-free offer. | No |
| `GA4_ID` | Defaults to `G-DDVX27NB26` (same property as business.poof.ca). | No |
| `STRIPE_PRICE_ID` | Defaults to `price_1U4PwmPLaXlBkTYFxqt7V0HT` — only set if the price changes | No |
| `FROM_EMAIL` | Defaults to `Poof <baz@poof.ca>` | No |
| `INTERNAL_EMAIL` | Defaults to `baz@poof.ca` (cc on every retailer email) | No |

**Test first:** use `sk_test_…` / `pk_test_…` on a Preview deployment, walk the
flow with card `4242 4242 4242 4242`, then `4000 0025 0000 3155` (3D Secure
challenge) and `4000 0000 0000 0002` (declined). Swap to live keys on
Production when it all passes.

## 4. Stripe — what's required (nothing new to build)

Already in place on `acct_1U4NCWPLaXlBkTYF`: product Retail Ad Network, price
`price_1U4PwmPLaXlBkTYFxqt7V0HT` (CAD $50, tax exclusive), coupon `mKwuq2u8`,
promo codes BUZZD / SENSE / UFEELU / POOF3LILY, Stripe Tax active.

Do these once:

0. **Create the launch-offer promotion code.** Stripe → Product catalog → Coupons → open `mKwuq2u8` (100% off, 3 months) → **Add promotion code** → code `LAUNCH3`, no expiry, no redemption limit. This is what "3 months free when you add a card" applies at go-live. If you use a different code, set `LAUNCH_OFFER_CODE` in Vercel.
1. **API keys** → step 3. Prefer a restricted key over the full secret key.
2. **Settings → Payment methods → Link: off.** The page already hides Link, this makes sure Stripe never shows it.
3. **Settings → Customer emails:** turn on "Successful payments" and "Refunds" so retailers get Stripe receipts after activation.
4. **No webhook is needed.** The flow verifies the SetupIntent server-side.
5. **Billing → Subscriptions → Automatic tax** is already active — `activate` passes `automatic_tax: enabled` so HST is added per location.

## 5. Point onboarding.poof.ca at Vercel

1. Vercel → Project → **Settings → Domains** → add `onboarding.poof.ca`.
2. Cloudflare → DNS → add **CNAME** `onboarding` → `cname.vercel-dns.com`, proxy **off** (grey cloud).
3. Wait for Vercel to show the green check. Set `SITE_URL` to `https://onboarding.poof.ca` and redeploy.

## 6. Route every marketplace link here

**business.poof.ca (Hostinger)** — add to the root `.htaccess`, above the existing clean-URL rules:

```apache
# Retailer onboarding now lives on its own host
RewriteEngine On
RewriteRule ^join/?$                 https://onboarding.poof.ca/ [R=301,L]
RewriteRule ^join/.*$                https://onboarding.poof.ca/ [R=301,L]
RewriteRule ^onboarding/?$           https://onboarding.poof.ca/ [R=301,L]
RewriteRule ^retailers/(join|signup|start|onboard)/?$ https://onboarding.poof.ca/ [R=301,L]
RewriteRule ^get-started/retailers?/?$ https://onboarding.poof.ca/ [R=301,L]
```

Then search the site files for links that should point here and change them to `https://onboarding.poof.ca` (no trailing path):

- `get-started.html` → the "For Retailers" button (already points to onboarding.poof.ca — confirm).
- `retailers.html` → every "Get started" / "Join" / "Sign up" CTA.
- `index.html` header nav and footer → "For retailers" link.
- `integrations.html` → the CTA at the bottom.
- Blog posts in Contentful → any "join Poof" link in the retailer posts (opening a store, retailer tools).

**poof.ca (consumer marketplace)** — the "Own a dispensary? Get listed / Claim your store" link in the footer and on each unclaimed store page → `https://onboarding.poof.ca`. Ethan has that codebase (SEO sprint).

**signup.poof.ca** stays live for phone closes. **join.poof.ca** (coverage map) stays as a sales tool.

**Email / HubSpot templates** → replace any `poof-early-access.vercel.app` or `business.poof.ca/join` link with `https://onboarding.poof.ca`.

## 7. Personal links for outreach

Every authorized store has its own link: `https://onboarding.poof.ca/s/<CRSA number>`. Open it and the flow starts with that store confirmed, then asks "There are N other [chain] locations — do you own any of them?" so franchisees pick only their doors.

- `data/store-links.csv` in this repo has all 1,856 links (chain, store, CRSA, address, city, link). Paste into your outreach sheet / HubSpot / LinkedIn sequences.
- Live download any time: `curl -H "x-admin-key: $ADMIN_KEY" https://onboarding.poof.ca/api/links -o links.csv` (add `?q=sessions` to filter). The key is header-only — never put it in a URL.
- A chain-level link also works: `https://onboarding.poof.ca?store=sessions-cannabis`.

## 8. Go-live day: activate a retailer

Find the customer in Stripe (search the store name; every record shows
`onboarding_stage: Agreement + Card`). Copy the `cus_…` id. Then:

```bash
curl -X POST https://onboarding.poof.ca/api/activate \
  -H "x-admin-key: YOUR_ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"customerId":"cus_XXXX"}'
```

Optional fields: `"referralCode":"BUZZD"` (overrides what they entered),
`"locations":["CRSA1188757","CRSA1208760"]` (activate a subset now; call again later with more and the quantity updates — no second subscription).

The response shows the subscription id, quantity, monthly amount and which
promo applied (`referral` beats `launch offer`). The customer's
`onboarding_stage` flips to `Live`. Move the Notion card.

**Franchise guard.** If any of the doors are already live on another customer
(a second franchisee signed up the same store), `activate` returns 409 with
the overlap. Resolve it with the two owners, then pass `"force":true` if you
really want it. At signup time the overlap is only flagged — in the internal
email under `FRANCHISE CONFLICT` and on the customer as `conflicts`.

**Card skipped at signup.** `card_on_file: no — collect on setup call` on the
customer. Take the card on the call (Stripe → customer → Add payment method →
set as default), then run `activate`. They don't get the launch offer.

## 9. Abandonment follow-up (Klaviyo)

With `KLAVIYO_API_KEY` set, every signup fires `Onboarding Started` the moment
they give an email (right after confirming the store), with properties
`stage`, `store`, `locations` and `resume_url`. `Onboarding Completed` fires at
the end. Build one flow:

- Trigger: metric `Onboarding Started`
- Flow filter: has **not** `Onboarding Completed` since starting this flow
- Wait 2 hours → Email: "You're two minutes from live — pick up where you left off" with a button to `{{ event.resume_url }}`
- Wait 2 days → Email: "Still want [store] shoppable? Here's the link again" + Calendly
- Wait 5 days → Email: last nudge, mention the offer ends `{{ 'December 31' }}`

The resume link carries their whole in-progress state (signed, 30-day expiry),
so it works on any device with nothing stored on our side.

## 10. What GA4 records

Events on property `G-DDVX27NB26`, each with `store`, `locations`, `entry`
(`link` | `search`): `onb_view`, `onb_store_confirmed`, `onb_email`,
`onb_question`, `onb_exit_sms`, `onb_exit_call`, `onb_franchise` (answer),
`onb_locations` (count), `onb_systems`, `onb_review`, `onb_terms`,
`onb_card_saved`, `onb_card_skipped`, `onb_complete` (card, offer),
`onb_waitlist`, `onb_resume`, `onb_map`. Build a funnel in GA4 → Explore from
`onb_view` → `onb_email` → `onb_locations` → `onb_terms` → `onb_complete`.

## 11. Sign-off checklist

- [ ] Preview deploy with test keys: full flow, 4242 card, 3DS card, declined card
- [ ] Personal link `/s/CRSA…` lands on the right store; "Yes, let me pick" opens the picker pre-ticked
- [ ] Skip-card path completes and the internal email says `Card on file: NO`
- [ ] `LAUNCH3` promotion code exists in Stripe; `activate` on a card-added test customer applies it
- [ ] Klaviyo shows `Onboarding Started` with a working `resume_url`
- [ ] Order Form PDF arrives by email (Resend) and the "Download your order form" link opens it
- [ ] Internal notification lands in onboarding@poof.ca
- [ ] Stripe customer shows the record and `accepted_by` / `accepted_at`
- [ ] `activate` on the test customer creates the subscription with the right quantity and HST
- [ ] `business.poof.ca/terms` opens (no `.html`) — the acceptance link depends on it
- [ ] Production deploy with live keys; walk it once with a real card, then void the SetupIntent in Stripe
- [ ] Redirects in step 6 return 301 to onboarding.poof.ca
