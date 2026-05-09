# RLS Gotchas (Things That Recurse)

This doc exists because on 2026-05-09 we shipped three RLS PRs that all
hit the same Postgres recursion bug, in three different shapes, in a
single afternoon. Two production hotfixes later, we wrote down the
rules. Read this *before* you write a Row-Level Security policy on
this codebase, and *especially* before you touch `user_roles`.

---

## TL;DR — Three rules

1. **Never put an inline `EXISTS (SELECT ... FROM T)` inside a policy
   on table `T`.** Always extract the check into a `STABLE SECURITY
   DEFINER` helper function (see `public.is_staff()` and
   `public.is_admin()` for the canonical pattern).

2. **`SECURITY DEFINER` bypasses RLS for the inner SELECT, but does
   not unwind Postgres' policy-recursion detector.** The detector
   tracks the chain at the table-reference level inside a single
   statement. One level deep into the same table works; two levels
   deep trips it. SECURITY DEFINER is necessary but not sufficient.

3. **When you add a new SELECT policy on a table that already has
   admin-gated UPDATE/INSERT/DELETE policies, audit those existing
   policies in the same PR.** They may have inline subqueries that
   worked fine until your new SELECT policy added a second layer to
   the chain. Update them or rewrite them to use a SECURITY DEFINER
   helper.

If you remember nothing else, remember rule 1.

---

## The 2026-05-09 incident (short postmortem)

### What we shipped

PR 1 (#285) added a new SELECT policy on `user_roles` to let admins
see the full team list (the page was showing only the current user
because of an earlier RLS hardening migration). The policy looked
correct on paper:

```sql
CREATE POLICY user_roles_admins_read_all ON public.user_roles
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.email = lower((SELECT auth.jwt()) ->> 'email')
        AND ur.role = 'admin'
    )
  );
```

### What broke

Every authenticated `SELECT` on `user_roles` started returning HTTP 500
with:

```
ERROR: infinite recursion detected in policy for relation "user_roles"
```

That cascaded:

- `AppContext.handleUserReady` couldn't read the caller's role →
  `isAdmin = false` for every authenticated user → real admins lost
  access to Settings, Accounting, BD Funnel, BD Goals.
- PR 3's restrictive policies on payroll/invoicing tables also did
  `EXISTS … FROM user_roles`; their inner SELECT routed through the
  same broken SELECT-RLS chain → payroll/invoicing queries failed too.

### Hotfix 1 (PR #289)

Rewrote `user_roles_admins_read_all` to call a new SECURITY DEFINER
function:

```sql
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_roles
    WHERE email = lower((auth.jwt() ->> 'email'))
      AND role = 'admin'
  );
$$;

CREATE POLICY user_roles_admins_read_all ON public.user_roles
  FOR SELECT TO authenticated
  USING (public.is_admin());
```

Direct SELECT on `user_roles` started working again. Admin features
returned. But...

### What we missed

Two *other* policies on `user_roles` had the same inline-EXISTS
pattern, untouched since 2026-02-14:

- `admins_update_user_roles` (UPDATE)
- `user_roles_admins_insert` (INSERT)

Those had been fine for ~3 months because before PR 1 there was only
*one* SELECT policy on `user_roles` (`user_roles_read_own` — a trivial
email-equality check with no inner subquery). When the inline EXISTS
in `admins_update_user_roles` fired its inner SELECT, only that
trivial policy evaluated — no recursion.

After hotfix 1, the chain on UPDATE became:

```
UPDATE user_roles
└─ admins_update_user_roles USING evaluates inline EXISTS
   └─ inner SELECT on user_roles triggers SELECT-RLS
      └─ user_roles_admins_read_all → is_admin()
         └─ DETECTED: re-entrance into user_roles policy stack
```

Two levels deep into `user_roles` in a single statement. Detector
tripped. Role-toggling buttons in Admin Settings started failing with
"Failed to update role."

### Hotfix 2 (PR #290)

Rewrote both UPDATE and INSERT policies to use `is_admin()` directly
— no inline EXISTS, no SELECT-RLS chain to trip. Done.

---

## The mechanism (why this happens)

Postgres' policy-recursion detector watches for a relation appearing
twice in the policy-evaluation stack inside a single statement. The
detector was added to prevent infinite loops when policies reference
each other, but its rule is conservative: **two table references in
the same statement's policy stack = error, regardless of whether
the inner reference is functionally bypassed by `SECURITY DEFINER`.**

That's why:

- `SELECT * FROM user_roles` works after hotfix 1: chain is one level
  deep (`user_roles → is_admin()`), and `is_admin()`'s inner SELECT
  bypasses RLS via SECURITY DEFINER → no second reference enters the
  stack.
- `UPDATE user_roles ...` failed: chain is two levels deep
  (`user_roles UPDATE policy → user_roles SELECT policy via inline
  EXISTS → is_admin()`), and the inline EXISTS *did* enter the stack
  even though `is_admin()`'s body bypassed RLS afterwards.
- PR 3's policies on payroll/invoicing tables work fine: chain is
  `invoices → user_roles → is_admin()`. Different tables. The
  detector doesn't flag this because `user_roles` only appears once in
  the chain.

The pattern that's *always* safe:

```
T's policy → public.is_T_thing()  (SECURITY DEFINER, body queries T)
```

The pattern that's *never* safe:

```
T's policy → inline subquery against T → ... anything else
```

The middle ground that broke us:

```
T's policy A → inline subquery against T → T's policy B
```

…which works *until* you add another policy B on T that references
the table again. Don't bet on policy B not existing in the future.

---

## The pattern to follow

For any role check or "is the caller X" predicate on a table with
RLS, use a helper function. Mirror these signatures exactly — they
work in production:

```sql
-- Existing in the codebase, both shipped 2026-02-14 and 2026-05-09.

CREATE OR REPLACE FUNCTION public.is_staff()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_roles
    WHERE email = lower((auth.jwt() ->> 'email'))
      AND role IN ('admin', 'member')
  );
$$;

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_roles
    WHERE email = lower((auth.jwt() ->> 'email'))
      AND role = 'admin'
  );
$$;
```

Critical attributes:

- `LANGUAGE sql` (not plpgsql) — simpler, no plan-cache surprises.
- `STABLE` — never `VOLATILE`. The result is deterministic within a
  transaction and Postgres can cache it across rows.
- `SECURITY DEFINER` — runs the body as the function owner
  (`postgres`), which has BYPASSRLS. **Required** for the inner SELECT
  not to recurse.
- `SET search_path TO 'public'` — defensive. Stops a malicious
  schema in `pg_temp` from shadowing `user_roles`.

Use them in policies via plain function call:

```sql
CREATE POLICY some_policy ON public.some_table
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());
```

Not via inline EXISTS. Ever.

---

## How to test before merging

Structural grep-style migration tests **cannot** catch RLS recursion.
By definition — they don't run the SQL. You need a runtime check.
Until the Phase B4 cross-tenant test harness ships, the cheapest
runtime check is a manual reproduction in the Supabase SQL editor
before you merge.

Recipe — paste this into the SQL editor, swap in your own values,
hit Run:

```sql
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims TO
  '{"email":"<a-real-admin-email>","org_id":"<their-org-id>"}';

-- Run the exact query the frontend will make. For role management:
SELECT email, role FROM public.user_roles ORDER BY email;
UPDATE public.user_roles SET role='member', updated_at=NOW()
  WHERE email='<some-other-admin>'
  RETURNING email, role;
INSERT INTO public.user_roles (email, role)
  VALUES ('test-new-user@example.com', 'member')
  RETURNING email, role;

ROLLBACK;
```

If any statement returns:

```
ERROR: 42P17: infinite recursion detected in policy for relation "user_roles"
```

**stop and fix before merging.** Don't rely on the migration's
sanity-check `DO` block — those check policy *existence*, not policy
*runtime correctness*.

Run the same recipe with a member email and a caregiver email to
confirm non-admins are still blocked from the operations they should
be blocked from.

---

## When in doubt

If you're touching RLS on `user_roles`, `caregivers`, `clients`, or
any other table central to auth/tenancy, and you're not certain the
chain is safe, **stop and ask the owner before merging.** A half-day
delay is much cheaper than another production incident.

If you're adding a new policy on a table that already has multiple
policies — even if your new policy seems trivial — assume the
existing ones may have latent recursion bombs and audit them as part
of your PR.

If `is_admin()` / `is_staff()` doesn't cover your check (e.g., you
need "is the caller a member of org X"), write a new SECURITY DEFINER
helper and add it to this codebase. **Don't write inline EXISTS in
the policy.** That's how we got here.

---

## Related references

- Hotfix PRs: #289 (SELECT policy), #290 (UPDATE/INSERT policies)
- Original RBAC PRs: #285, #286, #288
- SaaS retrofit Phase B4 (planned cross-tenant test harness):
  `docs/SAAS_RETROFIT_STATUS.md`
- Phase B5 (where all admin checks migrate from `user_roles` lookup
  to JWT `org_role` claim, and these helpers can be retired):
  `docs/SAAS_RETROFIT.md` → "Phase B"
