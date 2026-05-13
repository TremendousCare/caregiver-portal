import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { CheckCircle2, Mic, Square, MapPin } from 'lucide-react';
import { useBdAccounts } from './hooks/useBdAccounts';
import { useBdLogActivity, getCurrentPosition } from './hooks/useBdLogActivity';
import {
  parseDollarsToCents,
  validateActivityDraft,
  QUICK_CAPTURE_TYPES,
  QUICK_CAPTURE_LABELS,
  SPEND_CATEGORIES,
} from './lib/bdMutations';
import { searchAccounts, hasPreciseCoordinate } from './lib/bdQueries';
import { updateAccountLocation } from './lib/bdMutations';
import {
  VoiceRecorder,
  formatDuration,
  isRecordingSupported,
  MAX_RECORDING_SECONDS,
} from './lib/voiceRecorder';
import { supabase } from '../../lib/supabase';
import s from './BdPortal.module.css';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || '';

// Build a `<input type="datetime-local">` value for "right now" in
// the user's local timezone. The native input doesn't accept ISO with
// timezone, so we trim seconds + the trailing Z.
function nowLocalForInput() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

export function QuickCapture() {
  const { accountId: lockedAccountId } = useParams();
  const navigate = useNavigate();
  const { accounts, loading: accountsLoading } = useBdAccounts();
  const { submitting, submit } = useBdLogActivity();

  const [activityType, setActivityType] = useState('visit');
  const [accountId, setAccountId]       = useState(lockedAccountId ?? '');
  const [accountSearch, setAccountSearch] = useState('');
  const [notes, setNotes]               = useState('');
  const [spendInput, setSpendInput]     = useState('');
  const [spendCategory, setSpendCategory] = useState('meal');
  const [occurredLocal, setOccurredLocal] = useState(nowLocalForInput);
  const [gps, setGps]                   = useState(null);
  const [formError, setFormError]       = useState('');
  const [success, setSuccess]           = useState(null);

  // Pinned-location opt-in. When the rep logs a visit/drop-off, we have
  // GPS in hand and the account is right there in front of her — that's
  // the highest-quality coordinate we'll ever get. If the account doesn't
  // already have lat/lng, default to saving it. Toggle is rendered so
  // she can opt out if she's not actually at the account (e.g. logging
  // from her car on the way home).
  const [pinLocation, setPinLocation] = useState(true);

  // Voice memo recording state. Recorder lives in a ref so React
  // re-renders don't tear it down mid-recording.
  const recorderRef = useRef(null);
  const tickRef = useRef(null);
  const [recState, setRecState] = useState('idle'); // idle | recording | transcribing | error
  const [recElapsed, setRecElapsed] = useState(0);
  const [recError, setRecError] = useState('');
  const voiceSupported = isRecordingSupported();

  const lockedAccount = useMemo(
    () => (lockedAccountId ? accounts.find((a) => a.id === lockedAccountId) : null),
    [accounts, lockedAccountId],
  );

  // The selected account row (locked or picked). Drives the
  // "save this location" prompt below.
  const selectedAccount = useMemo(() => {
    if (lockedAccount) return lockedAccount;
    if (!accountId) return null;
    return accounts.find((a) => a.id === accountId) ?? null;
  }, [lockedAccount, accountId, accounts]);

  // Only offer the pin prompt when the rep is physically at the
  // account (visit / drop-off), we actually got a GPS fix, and the
  // account doesn't already have a precise coordinate stored.
  const offerPinLocation =
    (activityType === 'visit' || activityType === 'drop_off') &&
    Boolean(gps) &&
    Boolean(selectedAccount) &&
    !hasPreciseCoordinate(selectedAccount);

  // Try to grab a GPS pin in the background. Permissions prompt is
  // user-driven and asynchronous; we don't block the form on it.
  useEffect(() => {
    if (activityType !== 'visit' && activityType !== 'drop_off') return;
    let cancelled = false;
    getCurrentPosition().then((pos) => {
      if (!cancelled && pos) setGps(pos);
    });
    return () => { cancelled = true; };
  }, [activityType]);

  const filteredOptions = useMemo(() => {
    if (lockedAccount) return [];
    return searchAccounts(accounts, accountSearch).slice(0, 8);
  }, [accounts, accountSearch, lockedAccount]);

  const spendCents = parseDollarsToCents(spendInput);

  // ─── Voice memo handlers ───────────────────────────────────

  async function handleStartRecording() {
    setRecError('');
    setFormError('');
    if (!voiceSupported) {
      setRecError('Voice recording is not supported on this device.');
      return;
    }
    const recorder = new VoiceRecorder();
    recorderRef.current = recorder;
    try {
      await recorder.start();
    } catch (e) {
      setRecError(e?.message ?? 'Could not start recording.');
      recorderRef.current = null;
      return;
    }
    setRecState('recording');
    setRecElapsed(0);
    tickRef.current = setInterval(() => {
      const elapsed = recorder.elapsedSeconds();
      setRecElapsed(elapsed);
      // Hard stop at the cap so a forgotten recording doesn't run all
      // afternoon and overflow Whisper's per-request budget.
      if (elapsed >= MAX_RECORDING_SECONDS) handleStopRecording();
    }, 250);
  }

  async function handleStopRecording() {
    const recorder = recorderRef.current;
    if (!recorder) return;
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
    setRecState('transcribing');
    let blob;
    try {
      blob = await recorder.stop();
    } catch (e) {
      setRecError(e?.message ?? 'Recording failed.');
      setRecState('error');
      recorderRef.current = null;
      return;
    }
    if (!blob || blob.size === 0) {
      setRecError('No audio captured. Try again.');
      setRecState('error');
      recorderRef.current = null;
      return;
    }
    try {
      const transcript = await transcribeBlob(blob);
      // Append to any text the rep has already typed so we don't
      // clobber a manual draft.
      setNotes((prev) => (prev?.trim() ? `${prev.trim()}\n\n${transcript}` : transcript));
      setRecState('idle');
    } catch (e) {
      setRecError(e?.message ?? 'Transcription failed.');
      setRecState('error');
    } finally {
      recorderRef.current = null;
    }
  }

  function handleCancelRecording() {
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
    recorderRef.current?.cancel();
    recorderRef.current = null;
    setRecState('idle');
    setRecElapsed(0);
  }

  // Clean up if the component unmounts mid-recording (e.g. user
  // navigates away). Keeps the microphone from staying live.
  useEffect(() => {
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
      recorderRef.current?.cancel();
    };
  }, []);

  async function transcribeBlob(blob) {
    if (!supabase || !SUPABASE_URL) {
      throw new Error('Supabase not configured.');
    }
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;
    if (!token) throw new Error('Not signed in.');
    const form = new FormData();
    form.append('file', blob, `memo${blob.type.includes('mp4') ? '.mp4' : '.webm'}`);
    const resp = await fetch(`${SUPABASE_URL}/functions/v1/bd-transcribe`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    if (!resp.ok) {
      const t = await resp.text();
      throw new Error(`Transcription failed (${resp.status}): ${t.slice(0, 160)}`);
    }
    const j = await resp.json();
    return (j.transcript ?? '').trim();
  }

  async function handleSubmit() {
    setFormError('');
    const draft = {
      activity_type:  activityType,
      account_id:     accountId,
      occurred_at:    new Date(occurredLocal).toISOString(),
      notes,
      spend_cents:    spendCents,
      spend_category: spendCents > 0 ? spendCategory : null,
      gps_lat:        gps?.lat ?? null,
      gps_lng:        gps?.lng ?? null,
    };
    const validation = validateActivityDraft(draft);
    if (!validation.ok) {
      setFormError(validation.error);
      return;
    }
    try {
      const inserted = await submit(draft);
      // Best-effort: if the rep opted in (or left the default on),
      // pin this GPS coordinate to the account so geofencing and
      // routing light up for future visits. Never blocks the save —
      // the activity is the source of truth.
      if (offerPinLocation && pinLocation) {
        try {
          await updateAccountLocation(supabase, {
            accountId: draft.account_id,
            draft: { lat: draft.gps_lat, lng: draft.gps_lng },
          });
        } catch (e) {
          console.warn('pin-location failed:', e);
        }
      }
      setSuccess(inserted);
      // Pop back to the natural origin: the account profile if we
      // came from one, else the Today screen.
      setTimeout(() => {
        if (lockedAccountId) navigate(`/bd/accounts/${lockedAccountId}`);
        else navigate('/bd');
      }, 600);
    } catch (e) {
      setFormError(e?.message ?? 'Could not save. Try again.');
    }
  }

  if (success) {
    return (
      <div className={s.page}>
        <div className={s.card} style={{ textAlign: 'center' }}>
          <div className={s.successIcon} aria-hidden>
            <CheckCircle2 size={48} strokeWidth={1.75} />
          </div>
          <p className={s.briefingText}>Saved. Returning…</p>
        </div>
      </div>
    );
  }

  return (
    <div className={s.page}>
      <div className={s.detailHeader}>
        <button type="button" className={s.backBtn} onClick={() => navigate(-1)}>← Cancel</button>
        <h1 className={s.pageTitle} style={{ margin: 0 }}>Log activity</h1>
      </div>

      {formError && <div className={s.error}>{formError}</div>}

      {/* Activity type */}
      <div className={s.card}>
        <div className={s.sectionTitle}>Type</div>
        <div className={s.typeRow}>
          {QUICK_CAPTURE_TYPES.map((t) => (
            <button
              key={t}
              type="button"
              className={`${s.typeBtn} ${activityType === t ? s.typeBtnActive : ''}`}
              onClick={() => setActivityType(t)}
            >
              {QUICK_CAPTURE_LABELS[t]}
            </button>
          ))}
        </div>
      </div>

      {/* Account picker */}
      <div className={s.card}>
        <div className={s.sectionTitle}>Account</div>
        {lockedAccount ? (
          <div className={s.accountName}>{lockedAccount.name}</div>
        ) : accountsLoading ? (
          <p className={s.muted}>Loading your accounts…</p>
        ) : accountId ? (
          <div className={s.contactRow}>
            <div className={s.accountName}>{accounts.find((a) => a.id === accountId)?.name}</div>
            <button
              type="button"
              className={s.linkBtn}
              onClick={() => { setAccountId(''); setAccountSearch(''); }}
            >
              Change
            </button>
          </div>
        ) : (
          <>
            <input
              className={s.input}
              type="search"
              placeholder="Search by name or city"
              value={accountSearch}
              onChange={(e) => setAccountSearch(e.target.value)}
              autoFocus
            />
            <div className={s.accountList} style={{ marginTop: 8 }}>
              {filteredOptions.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  className={s.accountCard}
                  onClick={() => { setAccountId(a.id); setAccountSearch(''); }}
                >
                  <div className={s.accountName}>{a.name}</div>
                  <div className={s.accountMeta}>{a.city ?? '—'}</div>
                </button>
              ))}
              {accountSearch && filteredOptions.length === 0 && (
                <div className={s.empty}>No matches.</div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Notes */}
      <div className={s.card}>
        <div className={s.sectionTitle}>Notes</div>

        {voiceSupported && (
          <div className={s.voiceRow}>
            {recState === 'idle' && (
              <button
                type="button"
                className={s.voiceStartBtn}
                onClick={handleStartRecording}
              >
                <Mic size={16} aria-hidden />
                <span>Record memo</span>
              </button>
            )}
            {recState === 'recording' && (
              <>
                <button
                  type="button"
                  className={s.voiceStopBtn}
                  onClick={handleStopRecording}
                >
                  <Square size={14} fill="currentColor" aria-hidden />
                  <span>Stop · {formatDuration(recElapsed)}</span>
                </button>
                <button
                  type="button"
                  className={s.voiceCancelBtn}
                  onClick={handleCancelRecording}
                >
                  Cancel
                </button>
                <span className={s.voiceHint}>Recording — tap stop when done.</span>
              </>
            )}
            {recState === 'transcribing' && (
              <span className={s.voiceHint}>Transcribing your memo…</span>
            )}
            {recState === 'error' && (
              <button
                type="button"
                className={s.voiceStartBtn}
                onClick={handleStartRecording}
              >
                <Mic size={16} aria-hidden />
                <span>Try again</span>
              </button>
            )}
          </div>
        )}

        {recError && <div className={s.error} style={{ marginBottom: 8 }}>{recError}</div>}

        <textarea
          className={s.input}
          rows={4}
          placeholder="What happened? Who did you see?"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          style={{ resize: 'vertical', minHeight: 96 }}
        />
      </div>

      {/* Spend */}
      <div className={s.card}>
        <div className={s.sectionTitle}>Spend (optional)</div>
        <div className={s.spendRow}>
          <input
            className={s.input}
            type="text"
            inputMode="decimal"
            placeholder="$0"
            value={spendInput}
            onChange={(e) => setSpendInput(e.target.value)}
            style={{ flex: 1 }}
          />
          <select
            className={s.input}
            value={spendCategory}
            onChange={(e) => setSpendCategory(e.target.value)}
            disabled={spendCents === 0}
            style={{ flex: 1 }}
          >
            {SPEND_CATEGORIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>
      </div>

      {/* When */}
      <div className={s.card}>
        <div className={s.sectionTitle}>When</div>
        <input
          className={s.input}
          type="datetime-local"
          value={occurredLocal}
          onChange={(e) => setOccurredLocal(e.target.value)}
        />
        {gps && (
          <p className={`${s.muted} ${s.locationCapturedRow}`}>
            <MapPin size={12} aria-hidden />
            <span>Location captured ({gps.lat.toFixed(3)}, {gps.lng.toFixed(3)})</span>
          </p>
        )}
        {offerPinLocation && (
          <label className={s.saveLocationRow}>
            <input
              type="checkbox"
              checked={pinLocation}
              onChange={(e) => setPinLocation(e.target.checked)}
            />
            <span>Pin this spot as {selectedAccount.name}&rsquo;s location</span>
          </label>
        )}
      </div>

      <button
        type="button"
        className={s.button}
        onClick={handleSubmit}
        disabled={submitting}
      >
        {submitting ? 'Saving…' : 'Save activity'}
      </button>
    </div>
  );
}
