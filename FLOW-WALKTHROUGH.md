# Poof onboarding — line by line

Every step, in order, exactly as built. Retailer-facing copy on the left, what
the system does behind it on the right.

The worked example is **Kindling Cannabis** — 14 authorized stores, Greenline POS, Merrco,
Buddi, Canfleet, arriving with the referral code `BUZZD`.

---

## Phase 1 · Store  *(progress: step 1 of 6)*

**1.1 — Page loads.** No "Get Started" button. The search bar is the first thing on screen.

> **Your store is already on Poof.**
> Every licensed store in Ontario is listed on our marketplace — name and location. Shoppers can find you. They just can't buy from you yet.
> Let's turn that on. Takes about two minutes, and we'll fill in most of it for you.

**1.2 — Store search.**

> What's your store called? You can also search by address or CRSA licence number.

Typeahead against **2,611 AGCO records grouped into 1,024 banners**. Matches on five fields:

| They type | It matches |
|---|---|
| `kindling` | banner name, including partials and misspellings |
| `CRSA1194941` or `1194941` | licence number → jumps to that one store |
| `38 mill` | street address |
| `L7J 1H2` or `N9C` | postal code or FSA |
| `windsor` | city — shows who has the most stores there |

Cancelled licences stay searchable but rank last and are flagged. A licence or address match preselects that specific store.

**1.3 — Sibling banners.** *(only if detected)*

> Quick check — the register also lists **8 other stores** under a name close to yours. Some operators are listed this way when a branch is named after its neighbourhood rather than its city.
> Any of these yours?

Multi-select, plus **"All 8 are ours"**. This is the Kindling case: 14 authorized stores split across 9 banners because branches are named Mountainside, Meadowvale, Dundas rather than by city.

> Added — that's 8 more stores on the record.

**1.4 — Enrichment.** *(no interaction, ~2 seconds)*

> Give me a second — checking the AGCO register and looking you up on Google…

Behind it: merges all selected banners · pulls hours, phone, website, rating from Google Places anchored on the AGCO street address · fetches the retailer's homepage and fingerprints it for ~24 POS, menu and payment vendors · cross-references the Poof POS index.

**1.5 — Readback.** Separate messages with pauses, not a form:

> Here's what I've got. **Kindling Cannabis**, 14 locations in 12 cities — Brampton, Burlington, East York and 9 more.
> All 14 are showing **authorized to open** with the AGCO.
> Google has your Brampton store open **9 AM to 11 PM Monday through Saturday, and 10 AM to 9 PM Sunday**.
> It's got your phone as 905-555-0142 and your site as kindlingcannabis.ca, sitting at 4.6 stars across 812 reviews.
> You're on **Greenline** — we're already integrated with that, so stock and pricing sync from day one.
> Everything above lives in your admin panel once you're in, so nothing here is permanent.
> Does it look right as a starting point?

**Yes** → continue. **Something's off** → inline correction form for name, address, licence, phone, website.

Variants handled: *in progress* with the AGCO, *cancelled* licence, no hours found, no POS detected, not in the register at all.

**1.6 — Value beat.** The only part of the flow that sells.

> So here's where you stand today.
> Poof does around **30,000 marketplace views a month**. When someone in Brampton searches for what you carry, your store shows up — name and address, nothing else. They can't see your menu, can't check stock, can't order.
> Turning on the **Retail Ad Network** connects your POS, so your live inventory and prices appear, and brand-funded campaigns start routing those shoppers to your checkout instead of someone else's.
> It's **$50 per location, per month** — $700 for your 14 stores, plus HST. That covers what it costs us to build and hold open the connection to your POS — the integration itself, the stock and price sync, and the routing of every order into your system. No revenue share, and no cut of the orders we send you.

Four proof points: brands pay for the traffic · orders land in your POS · nothing charged until live · month to month, cancel any time.

**Sounds good** → continue. **I have a question first** → captured, passed to the rep, flow continues.

---

## Phase 2 · Locations  *(step 2 of 6)*

**2.1 — Which stores.** Skipped entirely for single-location retailers.

> Which of the 14 are we setting up? Most operators start with one and add the rest once they've seen it working.

Multi-select with **"All 14"**. If the search identified one store by licence or address, it offers that one directly instead.

**2.2 — Anything else.**

> That's 14 stores on the list. Anything else to add?

Three options: done · add another under the same banner · **add a store under a different name** (fresh search, already-selected stores filtered out).

---

## Phase 3 · Systems  *(step 3 of 6)*

**3.1 — One screen, three questions.**

> Now the practical bit — what are you running?

| | Options |
|---|---|
| **Point of sale** | Cova · Greenline · Other → text box |
| **Payment processor** | Merrco · Moneris · BlazePay · CovaPay · Other → text box |
| **E-commerce** | Buddi · Dutchie · Breadstack · Just our POS menu · Other → text box |

One **Continue**. Then:

> Perfect — we're already integrated with Greenline, so your stock and pricing sync from day one.

---

## Phase 4 · Delivery  *(step 4 of 6)*

> Do you offer delivery?

**Yes** →

> What do you use for your last-mile delivery software?

Canfleet · Onfleet · Something else *(reveals a text box on click)* · In-house (no software). Free text matches known vendors, so "we use canfleet" lands correctly.

> We work with Canfleet directly — we'll arrange access with them during setup.

**No** →

> Would you like to?

Yes/no, recorded for your delivery roadmap.

---

## Phase 5 · Details  *(step 5 of 6)*

**5.1 — Referral.**

> Last thing before setup — did a brand refer you? If so their code gets you **three months on us**.

**Has a code** → validated live against Stripe. `BUZZD`, `SENSE`, `UFEELU` are active. Invalid codes are rejected with a message.

**No code** →

> No problem — most stores come to us directly rather than through a brand.
> And nothing's charged until you're live, so there's no clock running on your side either way.
> If a brand you stock does have a code, mention it to your account manager on the call — we can still apply it. The three months start at go-live, not today.

**5.2 — Account owner.** Name, work email, mobile (optional).

---

## Phase 6 · Payment  *(step 6 of 6)*

**6.1 — Summary.**

> Excellent — here's a summary of what we have for your store.

Store · locations · licences · hours · POS · processor · e-commerce · delivery · **14 × $50.00 = $700.00/mo + HST** · account owner · referral.

**Looks right** → continue. **Change something** → captured as a note for the rep.

**6.2 — Terms acceptance.** This is the signature.

> Before the card — the paperwork, in one step.
> Accepting here covers all **14 locations** you've added, and lets us contact Greenline, Merrco, Buddi and Canfleet to set up your connection.
> **Nothing happens straight away.** Your account manager will call you first to walk through exactly what to expect — and we won't contact them until after that call, with you copied on every message.
> And it's **month to month** — you can cancel any time on 30 days' notice. No minimum term, no lock-in.

Four reassurances, then two **unchecked** boxes plus name and title:

1. I have read and agree to the [Poof Dispensary Agreement, Terms and Conditions, and Payments Policy] *(opens `/terms.html` in a new tab)*, on behalf of Kindling Cannabis and each of the 14 locations listed above.
2. I am authorised to enter into this agreement on behalf of the business, and I authorise Poof to contact our POS, payment and delivery providers to set up the integration.

Both boxes and both fields are required.

> Recorded — that's your signature on the order form, and we'll email you a copy with all your locations listed.
> Your account manager will be in touch within one business day to go through it with you before anything else happens.

**Recorded as evidence:** name · title · email · UTC timestamp · IP address · user agent · terms version and SHA-256 hash · the exact location list shown at that moment · authority affirmation.

**6.3 — Card.**

> Last step — the card we'll have on file for when you go live.
> Adding it now means that once you've approved everything, we can launch the same day instead of stopping to chase payment details. It also tells us you're serious, so your setup goes to the front of the queue.
> **Nothing is charged today.** You'll speak with our team, see your menu configured, and approve it — all before the first invoice. It stays **month to month**, cancel any time on 30 days' notice. You'd be joining **80+ Ontario retailers** already on the network.

Stripe **embedded** Checkout mounts inside the chat — no redirect. Above it, the quote:

```
$50.00 × 14 locations              $700.00
HST (13%)                           $91.00
BUZZD — first 3 months            −$791.00
Due today                            $0.00
From month 4, once live            $791.00
```

**Stripe setup mode.** A Customer and SetupIntent are created. **No PaymentIntent, no subscription, no charge.**

---

## The moment the card is saved

Five things fire from the Stripe webhook:

| # | What |
|---|---|
| 1 | Payment method pinned as the customer's default |
| 2 | **Order form PDF generated** — parties, Schedule C with all 14 locations and licences, systems, $700/mo, referral, acceptance block with the full evidence record |
| 3 | **Welcome email** from `baz@poof.ca`, order form attached |
| 4 | **Internal email** to `baz@poof.ca` — every field in the body, PDF attached, next-steps block naming Greenline, Merrco, Buddi and Canfleet |
| 5 | **Row written to the Google Sheet** — 34 columns, keyed on submission id so retries update rather than duplicate |

Optional: HubSpot contact created.

---

## What the retailer sees on screen

> **You're in.**
> Welcome to the Poof family. Your card is saved and **nothing has been charged**.
> Here's exactly what happens from here — the first one's already done.

| | Step | |
|---|---|---|
| ✅ | **Signed up** | Agreement accepted — your order form is on its way to your inbox |
| ● | **Baz will reach out** | Within one business day, to help you get set up and walk you through what to expect |
| | **We connect your systems** | We contact your integration partners, with you copied on every message |
| | **Your admin panel** | Login sent, menu configured, ready for your approval |
| | **Go live** | You approve, we launch, and the first invoice starts |

Two buttons: **Preview my store on the marketplace** and **Open business.poof.ca**.

The map opens a real street-level map with their 14 stores as pink pins, each with a 5 km dashed coverage cell, and a toggle: on shows **`km² covered by your 14 stores across 12 cities`**, off drops it to `0 km²` — *"your store is just a pin on the map."*

---

## The email they get

**From** Bazif Khan &lt;baz@poof.ca&gt; · **Reply-to** Bazif · **Attached** order form PDF

> **Welcome to the marketplace.**
>
> Dana, thank you for joining the platform. I'm Bazif, I founded Poof, and I'm excited to change the way brands work with you.
>
> **For the past few years brands have been paying to get *onto* your shelf. Now they're going to pay to move product *off* it.**
>
> That's what all 14 of your stores are now set up for — brand-funded demand, paid for by the brands you already carry, routed to you, fulfilled by your store at your prices.
>
> **NEXT STEPS** — We contact Greenline, Merrco, Buddi and Canfleet
> **I NEED ONE THING FROM YOU** — Tell me what's on your shelf
> **THIS WEEK, IF YOU CAN** — We get on a call → calendly.com/baz-poof/30min

---

## What happens off the flow

| When | Who | What |
|---|---|---|
| Same day | You | Order form lands at `baz@poof.ca`, row appears in the Sheet |
| ≤ 1 business day | Bazif | Calls the retailer, walks through expectations |
| After the call | You | Contact Greenline, Merrco, Buddi, Canfleet — **retailer copied** |
| Days 2–5 | Partners | Return integration credentials via the admin panel |
| Week 1–2 | You | Configure Poof HQ, send login, retailer approves |
| Go live | Ops | `POST /api/activate` → subscription created, quantity 14, coupon applied, **HST on top**, go-live email sent, tracker row updated to Live |

**This is the only moment money moves.** Everything before it is a stored card and a signed order form.

---

## Things that can go differently

| Situation | What happens |
|---|---|
| Store not in the AGCO register | Manual record built together, flow continues |
| Licence shows cancelled | Flagged on screen, retailer can correct |
| Application still in progress | *"We can set everything up now and flip you live the day your authorization lands"* |
| No POS detected | *"We'll sort that out on the setup call"* |
| Wrong answer given earlier | **Change an answer** chips re-ask that question and resume — nothing is deleted |
| Invalid referral code | Rejected with a message, flow continues |
| Terms not accepted | Card step is blocked server-side |
| Card abandoned | *"No problem — nothing was charged."* Details held 24 hours |
| Google Places unavailable | Manual path, no hours |
| Lookup fails entirely | Manual path, flow still completes |
