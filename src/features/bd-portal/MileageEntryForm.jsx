import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { CheckCircle2, Gauge, Trash2, Save } from 'lucide-react';
import { useBdAccounts } from './hooks/useBdAccounts';
import { useBdMileageEntry } from './hooks/useBdMileageEntries';
import { useBdLogMileage, fetchOrgMileageRate } from './hooks/useBdLogMileage';
import {
  validateMileageDraft,
  computeMilesFromOdometer,
  computeReimbursementCents,
  formatCents,
  formatMiles,
  isMileageEntryEditable,
  DEFAULT_MILEAGE_RATE_CENTS,
} from './lib/bdMileage';
import { supabase } from '../../lib/supabase';
import s from './BdPortal.module.css';

// Returns "YYYY-MM-DD" for today in the user's local timezone. The
// HTML <input type="date"> control speaks this format.
function todayLocalISODate() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}

const SOURCE_OPTIONS = [
  { value: 'manual',   label: 'Manual' },
  { value: 'odometer', label: 'Odometer' },
];

export function MileageEntryForm() {
  const { entryId } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { accounts, loading: accountsLoading } = useBdAccounts();
  const { entry: existing, loading: entryLoading } = useBdMileageEntry(entryId);
  const { submitting, save, remove } = useBdLogMileage();

  const [currentUserId, setCurrentUserId] = useState(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!cancelled) setCurrentUserId(session?.user?.id ?? null);
    })();
    return () => { cancelled = true; };
  }, []);

  // Form state. When editing, hydrate from the existing row.
  const [tripDate,    setTripDate]    = useState(todayLocalISODate);
  const [source,      setSource]      = useState('manual');
  const [miles,       setMiles]       = useState('');
  const [odoStart,    setOdoStart]    = useState('');
  const [odoEnd,      setOdoEnd]      = useState('');
  const [purpose,     setPurpose]     = useState('');
  const [accountId,   setAccountId]   = useState(searchParams.get('account_id') ?? '');
  const [activityId]                  = useState(searchParams.get('activity_id') ?? '');
  const [startLoc,    setStartLoc]    = useState('');
  const [endLoc,      setEndLoc]      = useState('');
  const [isRoundTrip, setIsRoundTrip] = useState(false);
  const [rateCents,   setRateCents]   = useState(DEFAULT_MILEAGE_RATE_CENTS);
  const [notes,       setNotes]       = useState('');
  const [formError,   setFormError]   = useState('');
  const [success,     setSuccess]     = useState(false);

  // Load the org's default rate for new entries. When editing, the
  // existing entry's frozen rate wins.
  useEffect(() => {
    if (entryId) return;
    let cancelled = false;
    fetchOrgMileageRate().then((r) => { if (!cancelled) setRateCents(r); });
    return () => { cancelled = true; };
  }, [entryId]);

  // Hydrate from existing entry on edit.
  useEffect(() => {
    if (!existing) return;
    setTripDate(existing.trip_date ?? todayLocalISODate());
    setSource(existing.source ?? 'manual');
    setMiles(existing.miles?.toString() ?? '');
    setOdoStart(existing.odometer_start?.toString() ?? '');
    setOdoEnd(existing.odometer_end?.toString() ?? '');
    setPurpose(existing.purpose ?? '');
    setAccountId(existing.account_id ?? '');
    setStartLoc(existing.start_location ?? '');
    setEndLoc(existing.end_location ?? '');
    setIsRoundTrip(!!existing.is_round_trip);
    setRateCents(existing.rate_cents_per_mile ?? DEFAULT_MILEAGE_RATE_CENTS);
    setNotes(existing.notes ?? '');
  }, [existing]);

  // When using odometer source, drive `miles` from the start/end
  // pair so the rep doesn't have to type the same number twice.
  useEffect(() => {
    if (source !== 'odometer') return;
    const computed = computeMilesFromOdometer(odoStart, odoEnd);
    if (computed !== null) setMiles(String(computed));
  }, [source, odoStart, odoEnd]);

  const milesForPreview = useMemo(() => {
    const n = Number(miles);
    if (!Number.isFinite(n) || n < 0) return 0;
    return isRoundTrip ? n * 2 : n;
  }, [miles, isRoundTrip]);

  const previewReimbursement = useMemo(
    () => computeReimbursementCents(milesForPreview, rateCents),
    [milesForPreview, rateCents],
  );

  const editable = entryId
    ? isMileageEntryEditable(existing, currentUserId)
    : true;

  async function handleSave(status) {
    setFormError('');
    const draft = {
      trip_date:           tripDate,
      source,
      miles:               milesForPreview,
      odometer_start:      source === 'odometer' ? odoStart : null,
      odometer_end:        source === 'odometer' ? odoEnd   : null,
      purpose,
      account_id:          accountId || null,
      activity_id:         activityId || null,
      start_location:      startLoc,
      end_location:        endLoc,
      is_round_trip:       isRoundTrip,
      rate_cents_per_mile: Number(rateCents) || 0,
      notes,
      status,
    };
    const validation = validateMileageDraft(draft);
    if (!validation.ok) {
      setFormError(validation.error);
      return;
    }
    try {
      await save(draft, entryId ?? null);
      setSuccess(true);
      setTimeout(() => navigate('/bd/mileage'), 700);
    } catch (e) {
      setFormError(e.message ?? 'Could not save mileage entry.');
    }
  }

  async function handleDelete() {
    if (!entryId) return;
    if (!window.confirm('Delete this draft entry? This cannot be undone.')) return;
    try {
      await remove(entryId);
      navigate('/bd/mileage');
    } catch (e) {
      setFormError(e.message ?? 'Could not delete entry.');
    }
  }

  if (entryId && entryLoading) {
    return (
      <div className={s.page}>
        <p className={s.muted}>Loading entry…</p>
      </div>
    );
  }

  if (entryId && !existing && !entryLoading) {
    return (
      <div className={s.page}>
        <div className={s.error}>This mileage entry could not be loaded — it may have been deleted.</div>
        <button type="button" className={s.button} onClick={() => navigate('/bd/mileage')}>
          Back to mileage
        </button>
      </div>
    );
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
        <button type="button" className={s.backBtn} onClick={() => navigate('/bd/mileage')}>← Cancel</button>
        <h1 className={s.pageTitle} style={{ margin: 0 }}>
          {entryId ? 'Edit trip' : 'Log a trip'}
        </h1>
      </div>

      {formError && <div className={s.error}>{formError}</div>}

      {entryId && !editable && (
        <div className={s.card}>
          <p className={s.muted}>
            This entry is {existing?.status ?? 'submitted'} and can no longer be edited.
            Contact an admin if it needs to change.
          </p>
        </div>
      )}

      <div className={s.card}>
        <div className={s.sectionTitle}>When</div>
        <input
          type="date"
          className={s.input}
          value={tripDate}
          onChange={(e) => setTripDate(e.target.value)}
          disabled={!editable}
        />
      </div>

      <div className={s.card}>
        <div className={s.sectionTitle}>Mileage</div>
        <div className={s.typeRow} style={{ marginBottom: 10 }}>
          {SOURCE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={`${s.typeBtn} ${source === opt.value ? s.typeBtnActive : ''}`}
              onClick={() => editable && setSource(opt.value)}
              disabled={!editable}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {source === 'odometer' && (
          <>
            <div className={s.sectionTitle} style={{ marginTop: 8 }}>Odometer start</div>
            <input
              type="number"
              inputMode="numeric"
              min="0"
              className={s.input}
              value={odoStart}
              onChange={(e) => setOdoStart(e.target.value)}
              placeholder="e.g. 54320"
              disabled={!editable}
            />
            <div className={s.sectionTitle} style={{ marginTop: 8 }}>Odometer end</div>
            <input
              type="number"
              inputMode="numeric"
              min="0"
              className={s.input}
              value={odoEnd}
              onChange={(e) => setOdoEnd(e.target.value)}
              placeholder="e.g. 54332"
              disabled={!editable}
            />
          </>
        )}

        <div className={s.sectionTitle} style={{ marginTop: 8 }}>
          Miles {source === 'odometer' && <span className={s.muted}>(auto from odometer)</span>}
        </div>
        <input
          type="number"
          inputMode="decimal"
          min="0"
          step="0.1"
          className={s.input}
          value={miles}
          onChange={(e) => setMiles(e.target.value)}
          placeholder="e.g. 12.5"
          disabled={!editable || source === 'odometer'}
        />

        <label className={s.saveLocationRow} style={{ marginTop: 10 }}>
          <input
            type="checkbox"
            checked={isRoundTrip}
            onChange={(e) => setIsRoundTrip(e.target.checked)}
            disabled={!editable}
          />
          <span>Round trip — double the miles above</span>
        </label>

        <div className={s.profileMeta} style={{ marginTop: 10 }}>
          <span className={s.profileMetaItem}>
            <Gauge size={14} strokeWidth={1.75} aria-hidden /> {formatMiles(milesForPreview)} mi total
          </span>
          <span className={s.profileMetaItem}>
            {formatCents(previewReimbursement)} @ {rateCents}¢/mi
          </span>
        </div>
      </div>

      <div className={s.card}>
        <div className={s.sectionTitle}>Purpose</div>
        <input
          type="text"
          className={s.input}
          value={purpose}
          onChange={(e) => setPurpose(e.target.value)}
          placeholder="e.g. Visit to Hoag discharge planner"
          maxLength={200}
          disabled={!editable}
        />

        <div className={s.sectionTitle} style={{ marginTop: 10 }}>Account (optional)</div>
        <select
          className={s.input}
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
          disabled={!editable || accountsLoading}
        >
          <option value="">— None —</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>

        <div className={s.sectionTitle} style={{ marginTop: 10 }}>From (optional)</div>
        <input
          type="text"
          className={s.input}
          value={startLoc}
          onChange={(e) => setStartLoc(e.target.value)}
          placeholder="e.g. Home office"
          maxLength={200}
          disabled={!editable}
        />

        <div className={s.sectionTitle} style={{ marginTop: 10 }}>To (optional)</div>
        <input
          type="text"
          className={s.input}
          value={endLoc}
          onChange={(e) => setEndLoc(e.target.value)}
          placeholder="e.g. Hoag Newport Beach"
          maxLength={200}
          disabled={!editable}
        />
      </div>

      <div className={s.card}>
        <div className={s.sectionTitle}>Rate (cents per mile)</div>
        <input
          type="number"
          inputMode="numeric"
          min="0"
          max="1000"
          className={s.input}
          value={rateCents}
          onChange={(e) => setRateCents(e.target.value)}
          disabled={!editable}
        />
        <p className={s.muted} style={{ marginTop: 6 }}>
          Defaulted from your agency&rsquo;s preferred rate. Override if you&rsquo;re using a different one.
        </p>
      </div>

      <div className={s.card}>
        <div className={s.sectionTitle}>Notes (optional)</div>
        <textarea
          className={s.input}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Anything you want to remember about this trip"
          rows={3}
          maxLength={2000}
          disabled={!editable}
        />
      </div>

      {editable && (
        <>
          <button
            type="button"
            className={s.button}
            onClick={() => handleSave('draft')}
            disabled={submitting}
          >
            <Save size={16} strokeWidth={2} aria-hidden /> {submitting ? 'Saving…' : 'Save trip'}
          </button>

          {entryId && (
            <button
              type="button"
              className={s.backBtn}
              onClick={handleDelete}
              disabled={submitting}
              style={{ marginTop: 12, width: '100%', color: '#B91C1C', borderColor: '#FECACA' }}
            >
              <Trash2 size={14} strokeWidth={2} aria-hidden /> Delete draft
            </button>
          )}
        </>
      )}
    </div>
  );
}
