# Caregiver PWA — Pre-Merge Smoke Test

Run this against a caregiver PR's **Vercel preview URL** (every PR gets one
— see the Vercel bot comment on the PR) **on a real phone** before
merging. It takes ~3 minutes and is designed to catch the failure modes
that unit tests can't: auth-lock hangs, stuck spinners, and the
offline/clock flow.

> Why this exists: three caregiver-auth bugs (change-password hang,
> sign-out no-op, infinite boot spinner) all shipped to production because
> they only manifest in a real browser session, not in the test suite. Run
> steps 1–4 every time and that class of bug can't reach caregivers again.

## Boot & auth (the highest-value checks)

1. **Cold boot.** Open the preview URL. The loading spinner must clear to
   the **login screen within a few seconds** — never an indefinite
   spinner. (Catches the GoTrue auth-lock boot wedge.)
2. **Sign in** with a test caregiver → lands on the shifts list.
3. **Sign out** → returns to the login screen promptly. (Catches the
   sign-out hang.)
4. **Change password.** Sign back in → "Change password" → enter current +
   a new 10+ char password → it shows the success state and does **not**
   hang on "Saving…". Sign out and back in with the new password to
   confirm. (Catches the auth-lock deadlock.)

## Core caregiver flow

5. Open today's shift → **Clock in** (allow location) → records, status
   flips to clocked-in.
6. Mark a care-plan task done/partial, add a shift note → saves.
7. **Clock out** → shift shows completed; the task log locks.

## Offline resilience

8. Turn on **Airplane Mode** mid-visit. Clock in/out or log a task → you
   should see the "saved on your device" / "waiting to sync" indicator,
   not an error.
9. Turn signal back on → the queued items sync automatically (the badge
   clears) within ~30s.

## Installed-PWA specifics (do at least once per release)

10. **Add to Home Screen from real Safari** (not an in-app browser), open
    from the icon, and repeat steps 1–4 in the installed app. Service-worker
    caching can behave differently than a browser tab.
11. After merging a fix, remember the installed app caches the old code —
    **force-quit and reopen** (an in-app refresh may not be enough).

---

If any of 1–4 fail, **do not merge** — it's almost certainly an auth-lock
issue (see `src/features/caregiver-portal/hooks/useCaregiverSession.js` and
the note in `src/lib/callCaregiverClock.js`).
