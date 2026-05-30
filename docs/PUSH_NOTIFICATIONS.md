# Caregiver Push Notifications — Setup

Shift reminders are delivered via **Web Push** (VAPID). This works on the
**installed** caregiver PWA on Android and on iOS 16.4+ (the app must be
added to the home screen first — see PR 1). Until the keys below are set,
the feature stays dormant: the "Turn on shift reminders" card is hidden
and the cron sender no-ops, so nothing breaks.

## One-time setup (owner)

### 1. VAPID keys

A keypair was generated for this rollout. The **public** key is safe to
commit/share; the **private** key is a secret (delivered separately — do
not paste it into the repo).

- `VAPID_PUBLIC_KEY` (public, app-wide):
  `BBuc8bnZZcwambnTy_CUZ4AO_Gj7zvMD28InZfFt5bvbjc4RVTf0geKjl_ti95pw6rl_EKQokrS7iDFmNVVXmcY`

To rotate later, run `node scripts/generate-pwa-icons.mjs`'s sibling
recipe (any VAPID generator), then update both places below. The public
key baked into the app and the one in Supabase secrets **must match**.

### 2. Frontend env (Vercel → Project → Settings → Environment Variables)

| Name | Value | Notes |
|------|-------|-------|
| `VITE_VAPID_PUBLIC_KEY` | the public key above | Production (and Preview if you want to test there). Redeploy after adding. |

### 3. Edge Function secrets (Supabase → Project → Edge Functions → Secrets)

| Name | Value |
|------|-------|
| `VAPID_PUBLIC_KEY` | the public key above |
| `VAPID_PRIVATE_KEY` | the private key (delivered separately) |
| `VAPID_SUBJECT` | optional — a `mailto:you@yourdomain` or an https URL. Falls back to `SUPABASE_URL`. |

### 4. Database migrations

After merge, run the **Deploy Database Migrations** workflow (dry-run,
then apply) for:
- `20260603130000_push_subscriptions.sql` — subscription table + RLS
- `20260603140000_shift_reminders_cron.sql` — `shifts.reminder_sent_at` + the every-15-min cron

The cron is scheduled from the vault `project_url` + `publishable_key`
secrets (same as the other background jobs); if those are missing the
migration logs a notice and skips scheduling.

### 5. Edge functions deploy

`send-push` and `shift-reminders` auto-deploy on merge to `main` via the
existing Deploy Edge Functions workflow. No manual step.

## How it works

- Caregiver opts in on the home screen → browser subscribes → row saved in
  `push_subscriptions` (RLS-scoped to that caregiver) → a confirmation push
  fires via `send-push` so they see it working.
- `shift-reminders` (cron, every 15 min) finds shifts starting within ~75
  min that haven't been reminded, pushes each assigned caregiver's devices,
  and stamps `shifts.reminder_sent_at` (so each shift reminds at most once).
- Expired subscriptions (push service returns 404/410) are marked
  `disabled_at` and skipped — no manual cleanup.

## Verifying

1. Install the PWA (Add to Home Screen) and open it.
2. Tap **Turn on shift reminders** → allow notifications. You should get a
   "Reminders are on" notification within a few seconds.
3. To test a reminder end-to-end without waiting, an admin can temporarily
   set a test shift to start ~1 hour out and wait for the next cron tick
   (or invoke `shift-reminders` manually from the Supabase dashboard).
