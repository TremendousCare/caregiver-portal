import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Gauge, Plus, CheckCircle2, Pencil } from 'lucide-react';
import { useBdMileageEntries } from './hooks/useBdMileageEntries';
import {
  formatCents,
  formatMiles,
  groupEntriesByMonth,
  totalsForEntries,
  MILEAGE_STATUS_LABELS,
} from './lib/bdMileage';
import s from './BdPortal.module.css';

// Renders the rep's own mileage entries, grouped by month, newest
// month first. Each entry is tappable when it's still a draft (the
// only editable state in v1).
export function MileageList() {
  const navigate = useNavigate();
  const { loading, entries, userId, error, refresh } = useBdMileageEntries();

  const months = useMemo(() => {
    const grouped = groupEntriesByMonth(entries);
    return Object.keys(grouped)
      .sort()
      .reverse()
      .map((key) => ({ key, entries: grouped[key] }));
  }, [entries]);

  const overallTotals = useMemo(() => totalsForEntries(entries), [entries]);

  return (
    <div className={s.page}>
      <div className={s.detailHeader}>
        <button type="button" className={s.backBtn} onClick={() => navigate('/bd')}>← Back</button>
        <h1 className={s.pageTitle} style={{ margin: 0 }}>Mileage</h1>
      </div>

      {error && (
        <div className={s.error}>
          {error.message ?? 'Could not load mileage entries.'}{' '}
          <button type="button" className={s.linkBtn} onClick={refresh}>Retry</button>
        </div>
      )}

      <div className={s.card}>
        <div className={s.sectionTitle}>This view</div>
        <div className={s.profileMeta} style={{ marginTop: 4 }}>
          <span className={s.profileMetaItem}>
            <Gauge size={14} strokeWidth={1.75} aria-hidden /> {formatMiles(overallTotals.miles)} mi
          </span>
          <span className={s.profileMetaItem}>
            {formatCents(overallTotals.reimbursement_cents)} reimbursable
          </span>
          <span className={s.profileMetaItem}>
            {entries.length} entr{entries.length === 1 ? 'y' : 'ies'}
          </span>
        </div>
        <button
          type="button"
          className={s.button}
          onClick={() => navigate('/bd/mileage/new')}
          style={{ marginTop: 12 }}
        >
          <Plus size={16} strokeWidth={2} aria-hidden /> Log a trip
        </button>
      </div>

      {loading && <p className={s.muted}>Loading…</p>}

      {!loading && entries.length === 0 && !error && (
        <div className={s.card}>
          <p className={s.empty}>
            No mileage entries yet. Tap <strong>Log a trip</strong> to record your first one.
          </p>
        </div>
      )}

      {months.map(({ key, entries: monthEntries }) => {
        const totals = totalsForEntries(monthEntries);
        return (
          <div className={s.card} key={key}>
            <div className={s.sectionTitle}>
              {formatMonthLabel(key)}
            </div>
            <div className={s.profileMeta} style={{ marginTop: 0, marginBottom: 8 }}>
              <span className={s.profileMetaItem}>{formatMiles(totals.miles)} mi</span>
              <span className={s.profileMetaItem}>{formatCents(totals.reimbursement_cents)}</span>
              <span className={s.profileMetaItem}>
                {monthEntries.length} trip{monthEntries.length === 1 ? '' : 's'}
              </span>
            </div>
            <div>
              {monthEntries.map((entry) => (
                <MileageRow
                  key={entry.id}
                  entry={entry}
                  isEditable={entry.user_id === userId && entry.status === 'draft'}
                  onClick={() =>
                    navigate(
                      entry.status === 'draft'
                        ? `/bd/mileage/${entry.id}`
                        : `/bd/mileage/${entry.id}/view`,
                    )
                  }
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function MileageRow({ entry, isEditable, onClick }) {
  return (
    <button
      type="button"
      className={s.timelineItem}
      onClick={onClick}
      style={{ width: '100%', textAlign: 'left', background: 'transparent', border: 'none', padding: 0 }}
    >
      <span className={s.timelineIcon} aria-hidden>
        <Gauge size={18} strokeWidth={1.75} />
      </span>
      <div className={s.timelineBody}>
        <div className={s.timelineHeader}>
          <span className={s.timelineType}>{entry.purpose}</span>
          <span className={s.timelineDate}>{formatTripDate(entry.trip_date)}</span>
        </div>
        <div className={s.profileMeta} style={{ marginTop: 4 }}>
          <span className={s.profileMetaItem}>{formatMiles(entry.miles)} mi</span>
          <span className={s.profileMetaItem}>{formatCents(entry.reimbursement_cents)}</span>
          {entry.account?.name && (
            <span className={s.profileMetaItem}>{entry.account.name}</span>
          )}
          <span className={s.profileMetaItem}>
            {entry.status === 'draft'
              ? <><Pencil size={12} strokeWidth={2} aria-hidden /> {MILEAGE_STATUS_LABELS[entry.status]}</>
              : <><CheckCircle2 size={12} strokeWidth={2} aria-hidden /> {MILEAGE_STATUS_LABELS[entry.status] ?? entry.status}</>
            }
            {isEditable ? ' — tap to edit' : ''}
          </span>
        </div>
        {entry.notes && <div className={s.timelineNotes}>{entry.notes}</div>}
      </div>
    </button>
  );
}

// "2026-05" → "May 2026". No Intl call (mobile cold start).
function formatMonthLabel(key) {
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  if (!m) return key;
  const year = m[1];
  const month = Number(m[2]);
  const names = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return `${names[month - 1] ?? key} ${year}`;
}

// "2026-05-16" → "Sat, May 16". Local-string-safe (no Date parse).
function formatTripDate(s) {
  if (!s) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s));
  if (!m) return s;
  // Parse in UTC, then format using the user's locale. trip_date is
  // a calendar day, so a fixed UTC noon avoids day-boundary drift
  // when rendered in the user's local timezone.
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
