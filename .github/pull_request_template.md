<!--
Fill in the sections that apply. Delete sections that do not.
If any "Yes" below is checked, double-check the retrofit checklist at the bottom.
-->

## Summary

<!-- 1–3 sentences on what this PR does and why. Link any design doc or issue. -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor (no behavior change)
- [ ] Documentation
- [ ] Schema change (migration)
- [ ] Auth / secrets / RLS change
- [ ] SaaS retrofit work (links to a phase in `docs/SAAS_RETROFIT.md`)

## Test plan

<!-- What did you verify and how? Include commands run, flows clicked through, preview URLs if relevant. -->

- [ ] `npm test` passes locally
- [ ] `npm run build` passes locally
- [ ] Smoke-tested on Vercel preview (describe which flows)

---

## Multi-tenancy / production-safety checklist

**Skip this section only for pure documentation, pure frontend styling, or pure test PRs.** Otherwise fill it in — it exists to prevent accidental drift from the SaaS retrofit plan (`docs/SAAS_RETROFIT.md`).

### Schema

- [ ] This PR does **not** `DROP`, `DELETE`, or `ALTER ... DROP` anything.
- [ ] Any new table includes `org_id uuid REFERENCES organizations(id)`.
- [ ] Any new `org_id` column is `nullable` initially, with a backfill strategy noted below.
- [ ] Any new table has RLS enabled with a policy that filters on `org_id` (or documents why not).
- [ ] Migration is additive and reversible. A DOWN script or rollback SQL is included or linked.

### Queries and edge functions

- [ ] Any new Supabase query is org-scoped (either explicit `WHERE org_id = ...` or relies on an enforcing RLS policy).
- [ ] Any new edge function reads `org_id` from the JWT or an explicit parameter; it does not read global data.
- [ ] Any new cron job iterates per-org, not globally.
- [ ] Any new event logged to the `events` table includes `org_id`.

### Secrets and integrations

- [ ] No new single-account env var was added for a tenant-sensitive integration (RingCentral, Microsoft, DocuSign, Anthropic, etc.).
- [ ] Any new integration credential is fetched via the per-org lookup pattern (`get_route_ringcentral_jwt_rpc`-style).

### Branding and configuration

- [ ] No new hardcoded references to "Tremendous Care," `tremendouscareca.com`, specific pipeline phase names, or specific user names/emails.
- [ ] Any configurable string is sourced from `organizations.settings`, a dedicated config table, or a prop passed in — never a constant that would vary per customer.

### Rollback plan (required for schema, auth, RLS, or secrets changes)

<!--
Describe exactly how to undo this PR if it causes a problem in production.
Example:
- Frontend regression: Vercel rollback to previous deploy.
- Migration bad: run the included DOWN script `<path>`.
- Auth hook misbehaving: toggle off in Supabase Dashboard → Authentication → Hooks.
-->

---

## Notes for reviewer

<!-- Anything the reviewer should pay extra attention to, known limitations, follow-up PRs. -->
