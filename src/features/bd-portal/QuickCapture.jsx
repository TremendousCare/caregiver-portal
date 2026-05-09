import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useBdAccounts } from './hooks/useBdAccounts';
import { useBdLogActivity, getCurrentPosition } from './hooks/useBdLogActivity';
import {
  parseDollarsToCents,
  validateActivityDraft,
  QUICK_CAPTURE_TYPES,
  QUICK_CAPTURE_LABELS,
  SPEND_CATEGORIES,
} from './lib/bdMutations';
import { searchAccounts } from './lib/bdQueries';
import s from './BdPortal.module.css';

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

  const lockedAccount = useMemo(
    () => (lockedAccountId ? accounts.find((a) => a.id === lockedAccountId) : null),
    [accounts, lockedAccountId],
  );

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
          <div style={{ fontSize: 40, marginBottom: 8 }}>✅</div>
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
          <p className={s.muted} style={{ marginTop: 8, fontSize: 12 }}>
            📍 Location captured ({gps.lat.toFixed(3)}, {gps.lng.toFixed(3)})
          </p>
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
