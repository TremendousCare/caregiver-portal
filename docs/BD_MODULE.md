# Business Development Module — Vision, Scope, and Build Plan

**Status**: Design locked, build not yet started.
**Owner**: Tremendous Care
**Branch**: `claude/design-bd-portal-Jde8c`
**First user**: New BD representative starting the week of 2026-05-11.
**Related docs**: `docs/SAAS_RETROFIT.md`, `docs/AGENT_PLATFORM_VISION.md`, `CLAUDE.md`.

---

## Purpose of this document

Tremendous Care is hiring its first dedicated business development (BD) representative. She needs a tool from day one. No off-the-shelf product fits cleanly: the home-care BD category is dominated by PlayMaker Health, which is functional but mediocre — a static contact database with claims data bolted on. Tremendous Care has a unique technical asset (the AI context layer) that, applied to BD, can produce something materially better than the incumbent.

This document is the durable record of how the BD module was scoped, what we are building first, what we are deferring, and why. It also captures the strategic angle: a great BD module is one of the strongest features the multi-tenant SaaS product (see `SAAS_RETROFIT.md`) can sell to other agencies.

If you are about to make any change to the BD data model, mobile surface, or AI briefing layer, read this first.

---

## Vision in one paragraph

A mobile-first BD tool — installed as a PWA on the rep's iPhone — where every visit, call, drop-off, and referral is captured in seconds, every account profile carries full relationship memory, and an AI co-pilot briefs her every morning on who to visit, why, and what to bring up. The same data closes the loop from referral → assessment → start of care, attributing revenue back to the source so we know which relationships pay. On day one the AI is L1 (suggest only); the architecture is built so we can promote actions to higher autonomy levels as outcomes accumulate. Every entity is `org_id`-scoped per the SaaS retrofit rules so this becomes a sellable module for other agencies once Phase D ships.

---

## Why we are building this in-house

Two reasons:

1. **No incumbent solves the actual problem.** PlayMaker, WellSky CRM, and Salesforce Health Cloud are static systems — they store data, the rep brings the memory. Our context-layer architecture (episodic, semantic, and procedural memory; event bus; outcome tracking) lets us build a tool that *learns*. Nobody in the home-care BD category has built this. It is our wedge.
2. **Strategic leverage for the SaaS product.** Every home-care agency has this problem. PlayMaker charges $200–$400 per seat per month for software the reps grudgingly tolerate. A working AI-memory-powered alternative is a headline feature when we sell to other agencies in Phase E.

---

## The persona — what a home-care BD rep does

Home-care growth comes through embedding into the local discharge ecosystem, not cold outbound. A typical day:

1. **Plan a route** through 4–8 referral-source accounts: hospitals, SNFs, ALFs, rehab/IRFs, geriatric care managers, elder-law attorneys, geriatricians.
2. **Visit in person.** Drop off lunch, do a quick education on what we do well, ask the discharge planner if anyone is going home this week.
3. **Capture the visit:** who they saw, what was discussed, action items, gifts/spend, the warmth read.
4. **Convert referrals.** A discharge planner texts a name → it becomes a client lead → assessment scheduled → start of care.
5. **Close the loop.** Thank the referrer, report on outcomes, come back with data.
6. **Educate.** Lunch-and-learns, CE-credit talks for social workers, community fairs.

The job is **relationship management at scale** — typically 60–150 active accounts and 200–400 named contacts, with weekly to bi-weekly touchpoints expected.

### Tremendous Care's current rep
- **Territory**: Half of Orange County, CA (zip-code list TBD before launch — North OC vs South OC split).
- **Primary device**: Personal iPhone, PWA installed to home screen.
- **Workflow today**: She does it all — referral → assessment → start of care. Future state may split BD and intake; the data model leaves room for it (`assigned_to` field on referrals).
- **Account types in scope**: hospitals & SNFs (discharge planners, case managers), ALFs / IL / memory care, professionals (GCMs, elder-law attorneys, financial planners, MDs).
- **Out of scope for v1**: direct-to-consumer (web leads, family searches).

---

## Competitive landscape

| Vendor | Layer | What they do well | What they do poorly |
|---|---|---|---|
| **PlayMaker Health** (WellSky-owned) | CRM + field rep | Industry-specific data model, mobile app with GPS check-ins, Medicare claims data via Trella, market-share dashboards. Category leader. | Static — does not learn. UX feels dated. Expensive (~$200–$400/seat/mo). Heavy implementation. |
| **Trella Health** (WellSky-owned) | Data | Best-in-class CMS claims analytics — referral sources, market share, leakage. Often sold as the data layer inside PlayMaker. | Pure analytics, not a CRM. Pricey ($1K+/mo licensing). |
| **Forcura** | Intake | Cleanly digitizes the inbound referral packet — faxes, EMR docs, intake workflow. | Different problem. Not a field-rep tool. Tremendous Care has this problem too — orthogonal opportunity. |
| **WellSky CRM** | CRM | Tight integration with WellSky EMR. | Locked to WellSky stack, generic feel. |
| **Homecare Homebase, MatrixCare, AlayaCare, CareSmartz360, AxisCare, HHAeXchange** | EMR + bolt-on CRM | Single-vendor consolidation appeal. | CRM modules are afterthoughts. Reps still buy PlayMaker on top. |
| **Salesforce Health Cloud** | General CRM | Configurability, mature platform. | Stupid expensive ($150+/seat plus high-five-figure implementation). Overkill for one rep. |
| **HubSpot** | General CRM | Cheap, fast, decent mobile. | Nothing healthcare-aware. No claims data, no field-rep workflow. |
| **Spotio, Repsly, Map My Customers** | Field rep workflow | Route optimization, geofenced check-ins, mileage logs. | Zero healthcare context. Reps double-enter into PlayMaker. |

The market is split into three layers: **data** (Trella, Definitive Healthcare), **CRM** (PlayMaker, WellSky), and **workflow** (Spotio, Repsly). Nobody is building the **AI-memory layer**. That is our gap to walk into.

### Implication for build sequencing

Do not compete with PlayMaker on the data layer (CMS claims) on day one — that is a six-to-twelve month integration project with substantial licensing cost. Compete on the AI/memory layer where we already have a head start. Add claims data later when we have multiple agencies on the platform and the cost can be amortized.

---

## Strategic edge — how the context layer applies to BD

Mapping each context-layer primitive to a BD capability:

| Context primitive | BD capability |
|---|---|
| Episodic memory | "Last visit you discussed Sarah's daughter's wedding. It was last weekend — ask how it went." |
| Semantic memory | "Accounts you visit weekly send 3.2× more referrals than ones you visit monthly. Riverside is at 18 days since last visit." |
| Event bus | Every visit, call, email, drop-off, referral, SOC is captured on the same rail — analytics are free. |
| Action outcomes | "You sent the brochure to 12 discharge planners last quarter; the 4 who replied accounted for 9 of your 14 starts of care." |
| Briefing system | Morning chat opens with route plan, cold-account warnings, contact birthdays, suggested talking points. |
| Graduated autonomy | L1 on day one (suggest only). After 60–90 days of outcome data, promote low-risk actions (auto-thank-you notes, calendar invites) to L2/L3. |

Nobody in home-care BD software has any of this. PlayMaker certainly doesn't.

---

## KPIs — the success funnel

The four KPIs the rep is measured on form a single funnel, which is the spine of the UI:

```
Visits  →  Referrals  →  Starts of Care
              ↑              ↑
        (volume metric)  (revenue metric)
              └──── conversion rate ────┘
```

Every screen rolls up to this funnel. The Today screen shows her week-vs-week. The account profile shows her funnel for that account over the last 90 days. The desktop report shows it sliced by account, contact, week, and lost-referral reason.

Targets and quotas live in a `bd_goals` table so they can be edited per-rep without redeploy.

---

## Locked-in MVP scope

The smallest tool that makes her successful on day one. All entities are `org_id`-scoped per the SaaS retrofit rules. All BD activities flow through the existing `events` bus so the AI context layer sees them automatically.

### Surfaces

1. **Today (mobile)** — AI-generated morning briefing, suggested route ranked by `(referral_volume × days_since_last_visit × conversion_rate)`, weekly counters vs goals (visits, referrals, SOCs).
2. **Account profile (mobile + desktop)** — header (name, type, address, last-visit), funnel mini-chart for last 90 days, contact list with role and last-touched, full activity timeline, AI-generated relationship summary.
3. **Quick capture (mobile)** — visit log with GPS auto-fill, voice-memo dictation (Whisper → AI extracts who/what/next-steps), photo and business-card OCR for fast contact creation.
4. **Referral intake (mobile)** — log a referral by picking account + contact + entering prospective client info; creates a `referral` row and a `client` lead in one step. `loss_reason` enum captured if it doesn't convert.
5. **Funnel report (desktop)** — visits → referrals → SOCs by account, contact, week. Cold-account list (>21 days). Lost-referral reason breakdown.
6. **Onboarding seeding (one-time)** — populate the initial account list from existing `clients.referral_source` free-text + Google Places geo-search of her territory zip codes; backfill the last 6–12 months of inferred referrals to establish a baseline.

### Cross-cutting features

7. **Email auto-logging** — connect her O365 inbox via existing `email_accounts` infra; auto-create `email` activities for known contacts. L1 autonomy preserved — she still composes and sends.
8. **Compliance: per-contact spend tracking** — every gift, meal, or drop-off has a `$` field; soft warning at configurable annual threshold (default $400/contact); annual export for compliance review. (See "Compliance considerations" below.)
9. **Goals dashboard** — weekly/monthly visit, referral, and SOC targets editable in settings UI.

---

## Long-term product vision

The MVP is the foundation, not the destination. This section captures what the great-product state looks like at maturity so deferred items don't quietly disappear.

### The North Star

A field BD rep walks into a hospital lobby. Her phone vibrates: *"Sarah is back from her wedding — you logged it three weeks ago. She typically refers Monday or Tuesday. Last week she mentioned a pending discharge — ask about it."* She walks in. After the visit she taps her phone, dictates thirty seconds, the AI extracts the next steps and drafts a thank-you for the previous referral. The morning after, the agency director opens the manager view and sees *"Riverside is converting at 67%, Oak Hill is at 12% — here's why, and here's what I'd suggest."* The AI is doing the remembering. The rep is doing the relating. The system gets smarter every week.

That is what we are building toward. The MVP makes the rep functional on day one; horizons 2 and 3 layer the intelligence and scale that turn this from a tool into a moat.

### Capability inventory by horizon

Every capability has a home. Items in **Horizon 1** ship with the MVP; items in **Horizon 2** and **Horizon 3** are sequenced but committed to.

| Capability | Horizon | Why this horizon |
|---|---|---|
| Accounts, contacts, activities, referrals data model | H1 | Foundation. Nothing else works without it. |
| Today screen with AI briefing and route | H1 | Day-one value. Reuses existing briefing infra. |
| Account profile (mobile + desktop) | H1 | Day-one value. Where memory shows up. |
| Quick capture: visit log + GPS + voice memo + photo + business-card OCR | H1 | The killer feature for mobile-first reps. |
| Referral intake linked to client lead | H1 | Closes the funnel. Without this, attribution doesn't work. |
| Funnel report (desktop) | H1 | Weekly review for owner. |
| Onboarding seeding (Trello + clients.referral_source + Google Places) | H1 | Day-one inventory. |
| Email auto-logging (O365) | H1 | Free leverage from existing email_accounts infra. |
| Per-contact spend tracking + compliance export | H1 | Anti-Kickback posture. Cheap to add early, expensive to retrofit. |
| Goals dashboard with weekly/monthly targets | H1 | The reason the dashboard exists. |
| Outcome learning (semantic memories from BD activities) | H2 | Needs 60–90 days of data; cron extends existing outcome-analyzer. |
| L2 autonomy: auto-draft thank-you notes, follow-ups, calendar invites | H2 | Promote once outcome data validates the patterns. |
| Cadences / multi-touch sequences | H2 | Templated nurture flows (new SNF onboarding, dormant revival). AI personalizes within templates. |
| Manager / leadership surface (per-rep dashboards, weekly review prep) | H2 | Owner gets analytic visibility; pre-req for scaling reps. |
| Lost-referral analytics + AI-generated coaching notes | H2 | "You're losing 40% of Riverside's referrals to insurance denial — pre-screen earlier." |
| Lunch-and-learn / event management | H2 | When she runs >2 events/month. CEU credit tracking, attendance, materials library. |
| Birthday / anniversary auto-reminders | H2 | Stored on contacts; surfaced on Today screen. |
| Photo memory ("who's that?") | H2 | Face/business-card recognition for fast contact recall. |
| Full offline-first PWA with sync queue | H2 | Add only if real connectivity pain shows up after 2 weeks. |
| L3 autonomy: auto-attribute SOCs to referrals, auto-send thank-yous | H2 | Higher trust, lower-stakes actions only. |
| CMS claims-data market intelligence (Trella or alternative) | H3 | Untapped accounts in territory, market share, leakage. Gated by per-org licensing; amortizes across multi-tenant SaaS. |
| Contact mobility tracking (auto-detect job changes) | H3 | Claims data or LinkedIn polling reveals when a discharge planner moves between facilities. |
| Relationship graph (who-knows-whom across orgs) | H3 | Influence mapping; surfaces second-order opportunities. |
| Multi-rep territory enforcement, account assignment, leaderboards | H3 | When a 2nd rep is hired. Round-robin, geographic, or account-type-based assignment. |
| Manager review workflows (approve activities, audit spend) | H3 | When agency size demands separation of duties. |
| Conversation intelligence (visit recording) | H3 (probably never) | HIPAA-fraught and awkward in-person. Voice memos cover 90% of the value. Skip unless reps demand it. |
| Integration ecosystem (DocuSign for service agreements, RingCentral SMS, calendar sync) | H3 | Reuses existing portal integrations; thin glue. |
| White-label / per-org configurable taxonomies, goals, thresholds | H3 | Required for SaaS Phase D. Ships with the SaaS retrofit. |
| L4 autonomy: AI-initiated outreach to dormant accounts | H3 | Highest trust. Gated on clean outcome data and explicit owner approval. |

### Horizon 1 — MVP (May 2026)

Goal: the rep is functional on day one. Foundation in place.

Outcomes by end of horizon:
- Rep has a clean account list (~20–30 surfaced from Trello import) and logs every visit, call, and referral in seconds.
- Owner has a weekly funnel report.
- AI briefing layer is live and getting better at being useful.
- All entities are `org_id`-scoped — module is sellable as part of the SaaS retrofit when Phase D ships.

### Horizon 2 — Differentiation (Q3 2026)

Goal: the AI starts doing work, not just remembering. The product becomes hard to leave.

Outcomes by end of horizon:
- AI auto-drafts thank-you notes, follow-ups, and calendar invites; rep approves with one tap.
- Cadences exist for the 3–4 most common scenarios (new SNF onboarding, dormant account revival, post-event follow-up).
- Manager surface gives the owner per-rep dashboards and lost-referral coaching insights.
- Outcome data is rich enough to validate which actions drive conversions; the autonomy promotion path is real, not theoretical.

### Horizon 3 — Moat (Q4 2026 / 2027)

Goal: market intelligence and multi-rep scale. The SaaS pitch becomes "we have what PlayMaker has, plus an AI that learns."

Outcomes by end of horizon:
- Claims-data feed integrated; territory market share, untapped accounts, and discharge volume trends are visible per account.
- Multi-rep operations: territory enforcement, account assignment, leaderboards, manager workflows.
- Contact mobility and relationship graph turn the system into a true relationship-intelligence asset.
- Integration ecosystem is complete; the BD module is the agency's BD operating system.

---

## Deferred items — explicit triggers

Items below have a horizon assignment in the inventory above. This section names the *trigger* — the condition that promotes them from "later" to "now."

| Item | Promotion trigger |
|---|---|
| Cadences / multi-touch sequences | She has >100 active accounts, OR a 2nd rep is hired. |
| CMS claims-data market intelligence | SaaS Phase E launch with multiple paying agencies — amortizes licensing. |
| Conversation intelligence (visit recording) | A rep explicitly asks for it twice. Default: never. |
| Lunch-and-learn / event management | She runs >2 events in a single month. |
| Contact mobility tracking | First time the AI gets a fact wrong because a contact moved without us knowing. |
| Full offline-first PWA | Two weeks of real use shows >5 sync failures per week. |
| Promotion to L2+ autonomy | 60–90 days of clean L1 outcome data, AND a specific action shows >85% acceptance rate from the rep. |
| Multi-rep territory enforcement | A 2nd BD rep is hired or contracted. |

---

## Data model sketch

All tables get `org_id uuid NOT NULL REFERENCES organizations(id)` plus an RLS policy that filters on the JWT's `org_id` claim. Per the SaaS retrofit rules, columns are added nullable, backfilled, then tightened — but since these are all new tables, we can require `NOT NULL` from creation.

```
accounts
  id, org_id, name, account_type ('facility'|'professional'),
  facility_subtype ('hospital'|'snf'|'alf'|'il'|'memory_care'|'rehab'|'hospice'|null),
  professional_subtype ('gcm'|'attorney'|'financial_planner'|'md'|null),
  address, city, state, zip, lat, lng,
  phone, website, notes,
  is_active, out_of_territory boolean default false,
  created_at, updated_at

account_contacts
  id, org_id, account_id (FK), name, title, role
    ('discharge_planner'|'case_manager'|'social_worker'|'admissions'|'ed'|'principal'|'other'),
  email, phone_mobile, phone_office, notes,
  birthday date null, is_primary boolean,
  is_active, created_at, updated_at

bd_activities
  id, org_id, account_id (FK), contact_id (FK nullable),
  activity_type ('visit'|'call'|'email'|'sms'|'drop_off'|'event'|'referral_received'),
  occurred_at, duration_minutes nullable,
  spend_cents int default 0, spend_category ('meal'|'gift'|'swag'|null),
  notes text, voice_memo_url nullable, photos jsonb default '[]',
  gps_lat numeric null, gps_lng numeric null,
  source ('manual'|'voice_memo'|'email_auto'|'calendar_sync'),
  created_by, created_at

referrals
  id, org_id, account_id (FK), contact_id (FK), client_id (FK nullable),
  referred_at, prospective_name, prospective_phone,
  status ('new'|'assessment_scheduled'|'assessment_complete'|'soc'|'lost'),
  loss_reason ('insurance_denied'|'chose_other_agency'|'patient_passed'|
               'did_not_qualify'|'lost_contact'|'other'|null),
  loss_reason_detail text,
  assigned_to text default 'bd_rep',  -- future: handoff to intake coordinator
  soc_at timestamptz null,
  created_at, updated_at

bd_goals
  id, org_id, user_id, period ('weekly'|'monthly'),
  visits_target int, referrals_target int, soc_target int,
  effective_from date, effective_to date null

bd_territories  -- v1.1, optional; for v1 we can store on user metadata
  id, org_id, user_id, zip_codes text[], named_regions text[]
```

### Wiring to existing systems

- **`events` bus**: every `bd_activity` insert fires `event_type='bd_activity_logged'` so the AI context layer indexes it.
- **`context_memory`**: per-account episodic memories are written when the AI summarizes a visit. Per-rep semantic memories ("you convert facility referrals 1.8× better than professional referrals") accrue from outcome analysis.
- **`action_outcomes`**: BD activity types added to the action enum for L1→L2 promotion later.
- **`clients`**: existing `referral_source` free-text is preserved during seeding; new referrals link via `referrals.client_id`. Eventually the free-text field can be deprecated once seeded data is verified.
- **`email_accounts`**: existing per-org email integration reused for auto-logging.

---

## Compliance considerations

Three areas worth naming:

1. **Anti-Kickback Statute / Stark Law.** Federal AKS prohibits offering anything of value to induce referrals for Medicare/Medicaid patients. Private-duty home care is mostly cash-pay so the surface area is smaller, but tracking gifts/meals per contact is a regulated activity in healthcare. The `bd_activities.spend_*` fields plus the soft-warning threshold and annual export are the v1 compliance posture. Owner sets the threshold (default $400/contact/year).
2. **PHI in referrals.** When a discharge planner texts a patient name, that's PHI. The same controls already in place for `clients` apply to `referrals`. RLS, encrypted at rest, no exports without auth.
3. **HIPAA / BAA.** No new sub-processors are introduced by this module beyond what the portal already has BAAs for (Supabase, Vercel, Anthropic for AI, OpenAI for Whisper). If we add Google Places for territory seeding, the data sent is account names and addresses (not PHI), so no BAA needed — but worth confirming when implementing.

---

## Build phases

Designed to land an end-to-end usable tool by the rep's start date, then layer enrichment over the following weeks.

### Phase 0 — Pre-start (this week)
- [x] Trello API access — using existing `trello-webhook` credentials. BD board: `iykstkqZ`.
- [x] Migration scaffolding for `bd_accounts`, `bd_account_contacts`, `bd_activities`, `bd_referrals`, `bd_goals`, `bd_trello_import_staging`. Org-scoped, RLS in place. (`supabase/migrations/20260508120000_bd_module_phase_0_foundation.sql` — pending review and `Deploy Database Migrations` workflow run.)
- [ ] Run **stratified Trello import** (see "Trello import strategy" section below).
- [ ] Seed remaining accounts from existing `clients.referral_source` + Google Places geo-search.
- [ ] Backfill 6–12 months of inferred referrals from existing client records → baseline metrics.
- [ ] Insert her starter goals (see "Goals trajectory" section).
- [ ] **(Deferred)** Lock territory zip-code list — not blocking; defaults to no territory filter.

### Phase 1 — Day one (her first week)
- [ ] Today screen (mobile) — briefing, route, counters.
- [ ] Account profile (mobile) — header, funnel, contacts, timeline, AI summary.
- [ ] Quick capture (mobile) — visit log, voice memo, photo upload.
- [ ] Referral intake (mobile) — log referral, link to client lead.
- [ ] Goals stored per-user; weekly counters update live.

### Phase 2 — Weeks 2–4
- [ ] Funnel report (desktop) — by account/contact/week, lost-reason breakdown.
- [ ] Email auto-logging via O365.
- [ ] Cold-account list with configurable threshold.
- [ ] Compliance export (per-contact spend annual report).
- [ ] Account profile on desktop (parity with mobile).

### Phase 3 — Months 2–3 (data accumulation)
- [ ] Outcome analysis cron extended to BD activities — generate semantic memories about what works for *her*.
- [ ] AI summary quality tuning based on real notes.
- [ ] Promote first L1 actions to L2 (e.g., auto-draft thank-you notes for review).

### Phase 4 — When SaaS Phase D ships
- [ ] Per-org branding and templates for the BD module (configurable account taxonomies, goal defaults, compliance thresholds).
- [ ] Multi-rep support: territory enforcement, leaderboards, manager review surface.
- [ ] CMS claims-data integration (Trella or alternative) for market intelligence — gated by per-org licensing.

---

## Trello import strategy

Tremendous Care has a Trello board (`https://trello.com/b/iykstkqZ/business-development`, short ID `iykstkqZ`) with months of accumulated BD history from a previous rep. No one has touched it in months. The import goal is to preserve every signal the AI memory layer can use without overwhelming the new rep on day one.

**Source path: Trello REST API**, using the existing `TRELLO_API_KEY` / `TRELLO_API_SECRET` / `TRELLO_TOKEN` Supabase env vars already provisioned for the `trello-webhook` edge function (`supabase/functions/trello-webhook/index.ts`). No new credentials required. API gives richer data than JSON export (paginated action history, attachments via signed URLs, member metadata) and lets us optionally register a live webhook later for ongoing sync if the team continues using the BD board during transition.

**Strategy: import everything to the database, but stratify what surfaces in her UI.**

| Tier | Definition | Where it surfaces |
|---|---|---|
| **A — Active** | Accounts with any logged activity in last 12 months, OR among the top ~20–30 by inferred referral volume from existing `clients.referral_source` | Her main account list, route planner, and morning briefing |
| **B — Dormant** | Everything else with valid contact info | Searchable but not in default views. Type "Riverside" → it appears. AI surfaces them when relevant ("You visited Riverside in 2024 — Sarah was your contact then.") |
| **C — Archive** | One-off cards, scratch notes, exploratory ideas, junk | Stored as text-blob entries in `context_memory` (semantic / historical), not as accounts. AI can reference, rep never sees in lists. |

**All historical Trello notes and comments become `bd_activities` rows** with `source='trello_import'` and the original card date. Rep's timeline view defaults to last 90 days (clean). AI sees the full corpus (rich memory). Nothing is lost; nothing is overwhelming.

Day-one expectation: she sees ~20–30 accounts in her main view — enough to work with, few enough to dig into each one in her first two weeks.

### Import pipeline

1. Fetch full board snapshot from Trello REST API:
   - `GET /boards/{boardId}?cards=all&card_attachments=true&lists=all&members=all&labels=all` — board structure, lists (likely BD pipeline stages), all cards with attachments and labels.
   - `GET /boards/{boardId}/actions?limit=1000&filter=commentCard,createCard,updateCard,addAttachmentToCard&before=...` — paginated action history. Loop with `before=<earliest_action_date>` until empty so we capture the full timeline.
   - `GET /cards/{cardId}/actions` for any cards needing deeper history.
2. Persist raw payload to a temporary table (`trello_import_staging`) so the import is idempotent and re-runnable without hitting Trello again.
3. AI pass over each card to extract structured fields: account name, account type (facility / professional), contact name(s), role, phone, email, last touch date, content type (referral, drop-off, note, idea, junk).
4. Stratify into A/B/C tiers by recency and signal density.
5. Stage results for owner review before going live (catch obvious errors — e.g., a personal note misclassified as an account).
6. Load: A and B → `accounts` + `account_contacts` rows; comments/activities → `bd_activities` with original timestamps and `source='trello_import'`; C → `context_memory` blobs.
7. Generate a "what was imported" report for the rep so she understands her starting inventory.

### Trello list → account-tier hint

Trello board lists (e.g., "Active referrers", "Cold leads", "Lost", "Ideas") are a strong prior for the A/B/C stratification. The AI extraction step will weight the source list when deciding tier — e.g., a card on "Active referrers" with a recent comment lands as Tier A regardless of pure recency math. Final assignment still requires owner review.

---

## Goals trajectory

Owner-set referral targets with proposed visit and SOC complements. SOC numbers assume ~75% referral conversion and a 2–4 week lag.

| Month | Visits/week (target) | Client referrals (locked) | SOCs/month (estimated) |
|---|---|---|---|
| Month 1 | ~35 (heavy intro tour, build pipeline) | 0 | 0 |
| Month 2 | ~35 | 2–3 | 0–2 |
| Month 3 | ~35 | 4 | 2–3 |
| Month 4+ | ~35 | 4–6 | 3–5 |

Owner-set visit cadence is ~35 visits/week as a flat baseline (subject to change as we learn what's sustainable). Goals are stored in `bd_goals` with `effective_from` / `effective_to` dates so the trajectory is data, not code. Editable from the settings UI without redeploy.

---

## Open decisions

These are not blocking the MVP build but should be resolved before the corresponding phase.

| Decision | Needed by | Notes |
|---|---|---|
| Territory definition | Deferred — may cover all of Orange County | Owner deferred the territory decision (round 5). For now, no territory filter is applied; all OC accounts are surfaced. The `bd_accounts.out_of_territory` column ships with default `false` so a territory filter can be flipped on later without a migration. North OC is the likely future scope but not locked. |
| ~~Trello access~~ | ~~Phase 0~~ | **Resolved**: REST API via existing `TRELLO_API_KEY` / `TRELLO_TOKEN` Supabase env vars. Board: `iykstkqZ` (Business Development). |
| Annual per-contact spend threshold | Phase 2 (compliance export) | Default $400 unless owner sets otherwise. |
| Voice memo retention policy | Phase 1 (quick capture) | Audio files in Supabase Storage. Default: 90 days, then transcript-only. |
| Whisper provider (OpenAI vs Anthropic-native vs self-hosted) | Phase 1 | OpenAI Whisper API simplest; cost ~$0.006/min. Self-host if HIPAA stance demands. |
| Email integration scope | Phase 2 | Auto-log only, or auto-log + auto-suggest replies? Suggested: auto-log only at L1. |

---

## Conversation log

This module's design was hashed out in a single session on 2026-05-08. Key inputs from the owner:

- **Top referral sources to model:** hospitals & SNFs, ALFs / IL / memory care, professionals (GCMs, attorneys, financial planners, MDs). Direct-to-consumer out of scope.
- **Primary device:** mobile-first, personal iPhone PWA.
- **AI autonomy on day one:** L1 (suggest only). Will promote later as outcome data accumulates.
- **Success metrics:** visits, referrals, starts of care, conversion rate — all four matter.
- **Intake handoff:** rep does everything for now; future-proof with `assigned_to` field.
- **Territory:** half of Orange County, with off-territory exceptions allowed (tagged, excluded from cold-list).
- **Offline mode:** low priority — most of her day has signal.
- **Strategic positioning:** build with `org_id` from day one so the module is sellable as part of the multi-tenant SaaS in Phase E.

The owner explicitly approved locked-in MVP scope and deferred items as listed above. Build begins on `claude/design-bd-portal-Jde8c`. No PRs opened yet.

### Round 2 (same session, after first doc landed)

- **Trello import strategy**: stratified A/B/C tiers approved. Full corpus to AI; clean ~20–30 accounts to rep on day one.
- **Goal trajectory locked**: 0 referrals month 1 → 2–3 month 2 → 4 month 3 → 4–6/month month 4+. Visit and SOC complements proposed and accepted directionally (will tune from real data after month 2).
- **Intake handoff**: BD rep books assessments today; future-proofed via `assigned_to` field and role abstraction (no hardcoded "BD rep" references in UI or business logic).
- **Long-term product vision added**: three-horizon roadmap (MVP → Differentiation → Moat) with full capability inventory so deferred items have explicit homes and promotion triggers.

### Round 3 (same session)

- **Visit goal updated**: ~35 visits/week as a flat baseline across all months (subject to change). Replaces the earlier ramped 30→25→22→20 proposal.
- **Trello import path resolved**: REST API via existing portal credentials. Board confirmed as `iykstkqZ` (Business Development). No new secrets required. Existing `trello-webhook` edge function and `src/lib/trelloParser.js` are prior art for parsing patterns.
- **Phase 0 ready to start** pending only the territory zip-code list.

### Round 4 (same session)

- **Territory: North Orange County** confirmed. Default city list of 16 documented in Open Decisions; owner to confirm borderline cities (Garden Grove, Orange) before the Google Places geo-search sweep.
- **Territory does not block migrations or Trello import** — those run regardless. Territory is only required for the geo-search supplement (Phase 0 step 5) and downstream UI filtering. Phase 0 steps 1–4 can begin immediately.

### Round 5 (same session)

- **Territory deferred entirely**: she may cover all of Orange County; we'll revisit. No territory filter applied for now. `bd_accounts.out_of_territory` ships with default `false` so the filter can be turned on later without a migration.
- **Phase 0 migration written**: `supabase/migrations/20260508120000_bd_module_phase_0_foundation.sql` creates `bd_accounts`, `bd_account_contacts`, `bd_activities`, `bd_referrals`, `bd_goals`, and `bd_trello_import_staging`. All `org_id`-scoped per the SaaS retrofit rules with `tenant_isolation_<table>_<command>` policies and `service_role_full_access_<table>` for cron/edge-function access. Rollback at `_rollback/20260508120000_bd_module_phase_0_foundation_down.sql`.
