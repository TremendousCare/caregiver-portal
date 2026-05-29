-- ─────────────────────────────────────────────────────────────────
-- Transcription provider: safe default is Whisper, not RingSense
--
-- Incident: call transcripts stopped landing in caregiver/client notes
-- on 2026-05-27. Root cause: communication_voice_config.transcription_
-- provider was 'ringcentral_native' (set 2026-05-12) but the deployed
-- code only began *honoring* that column on 2026-05-27. RingSense
-- (ringcentral_native) requires a RingSense license on the RC plan plus
-- the RingSense OAuth scope / "RingSense for Sales - Access Insights"
-- permission on the JWT. Tremendous Care's account has none of these, so
-- every insights fetch returned 404 ("not ready"), the post-call cron
-- soft-failed and gave up after 24h, and ~100 calls were marked done
-- with no transcript. The previous behavior — download the recording and
-- transcribe via OpenAI Whisper — worked 100% of the time and had no such
-- precondition.
--
-- Fix: make Whisper the default transcription provider. RingSense stays a
-- fully supported option but must be an explicit, verified opt-in per org
-- (set transcription_provider = 'ringcentral_native' or 'both' only after
-- confirming the RingSense license + scope are actually present). This
-- mirrors the matching change to resolveTranscriptionProvider()'s
-- in-code fallback in _shared/operations/transcribeRecording.ts.
--
-- Idempotent and additive: only changes the column default and re-points
-- rows still on the old default. No data is dropped; rows that an org has
-- intentionally set to a specific provider are left untouched.
-- ─────────────────────────────────────────────────────────────────

-- 1. New rows default to the proven path.
ALTER TABLE public.communication_voice_config
  ALTER COLUMN transcription_provider SET DEFAULT 'whisper';

-- 2. Re-point any existing row still sitting on the old, unsafe default.
--    In production the live row was already flipped to 'whisper' during
--    incident response, so this is a no-op there; it exists so the
--    deployed state is reproducible from migrations in any environment.
UPDATE public.communication_voice_config
SET transcription_provider = 'whisper',
    updated_at = now()
WHERE transcription_provider = 'ringcentral_native';
