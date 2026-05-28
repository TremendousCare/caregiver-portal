import { useMemo, useState } from 'react';
import {
  Plus, Pencil, Trash2, RefreshCw, AlertCircle, Users, UserX, Mail, Calendar, Briefcase,
} from 'lucide-react';
import { useApp } from '../../shared/context/AppContext';
import { useExecStaff } from './hooks/useExecStaff';
import { Modal } from './components/Modal';
import { StaffForm } from './components/StaffForm';
import s from './ExecStaffPage.module.css';

const FILTERS = [
  { value: 'active',    label: 'Active' },
  { value: 'inactive',  label: 'Inactive' },
  { value: 'all',       label: 'All' },
];

function fmtDate(iso) {
  if (!iso) return '—';
  // Use UTC to avoid TZ drift; staff_members.hire_date is a DATE
  // column with no timezone, so we parse it explicitly.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toLocaleDateString(undefined, {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function yearsAt(hireDate) {
  if (!hireDate) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(hireDate);
  if (!m) return null;
  const hire = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const now = new Date();
  const ms = now.getTime() - hire.getTime();
  if (ms < 0) return null;
  const years = ms / (1000 * 60 * 60 * 24 * 365.25);
  if (years < 1) {
    const months = Math.floor(ms / (1000 * 60 * 60 * 24 * 30.4375));
    return `${months} month${months === 1 ? '' : 's'}`;
  }
  return `${years.toFixed(1)} years`;
}

export function ExecStaffPage() {
  const { currentOrgRole, showToast } = useApp();
  const readOnly = currentOrgRole !== 'owner';
  const {
    loading, submitting, staff, error, refresh,
    createStaff, updateStaff, deleteStaff,
  } = useExecStaff();

  const [filter, setFilter]     = useState('active');
  const [editing, setEditing]   = useState(null); // { mode: 'create'|'edit', staff? }

  const filteredStaff = useMemo(() => {
    if (filter === 'all') return staff;
    if (filter === 'active')   return staff.filter((m) => m.active);
    if (filter === 'inactive') return staff.filter((m) => !m.active);
    return staff;
  }, [staff, filter]);

  async function handleSave(draft) {
    if (editing?.mode === 'edit') {
      await updateStaff(editing.staff.id, draft);
      showToast?.('Staff updated.');
    } else {
      await createStaff(draft);
      showToast?.('Staff added.');
    }
    setEditing(null);
  }

  async function handleDelete(member) {
    const name = `${member.first_name}${member.last_name ? ' ' + member.last_name : ''}`;
    const msg = `Permanently delete ${name}? Their record is removed but any past Executive task instances that reference them stay intact.\n\nFor employees who left, prefer marking them Inactive instead — that preserves history. Use Delete only for typos / accidental adds.`;
    if (!window.confirm(msg)) return;
    try {
      await deleteStaff(member.id);
      showToast?.('Staff removed.');
    } catch (e) {
      window.alert(e?.message ?? 'Could not delete.');
    }
  }

  return (
    <div className={s.page}>
      <div className={s.header}>
        <div className={s.headerLeft}>
          <h1 className={s.title}>
            <Users size={26} style={{ verticalAlign: 'middle', marginRight: 8 }} />
            Staff directory
            {readOnly && <span className={s.roBadge}>Read-only</span>}
          </h1>
          <p className={s.subtitle}>
            {readOnly
              ? 'View-only — owners manage the team roster.'
              : 'Add staff with their hire dates so lifecycle templates (30 / 60 / 90 / anniversary) can anchor to them.'}
          </p>
        </div>
        <div className={s.headerRight}>
          <button type="button" className={s.secondaryBtn} onClick={refresh}>
            <RefreshCw size={14} />
            Refresh
          </button>
          {!readOnly && (
            <button
              type="button"
              className={s.primaryBtn}
              onClick={() => setEditing({ mode: 'create' })}
              disabled={submitting}
            >
              <Plus size={14} />
              Add staff
            </button>
          )}
        </div>
      </div>

      <div className={s.filters} role="tablist" aria-label="Status filter">
        {FILTERS.map((f) => {
          const count = f.value === 'all'
            ? staff.length
            : f.value === 'active'
              ? staff.filter((m) => m.active).length
              : staff.filter((m) => !m.active).length;
          return (
            <button
              key={f.value}
              type="button"
              role="tab"
              aria-selected={filter === f.value}
              className={`${s.filterBtn} ${filter === f.value ? s.active : ''}`}
              onClick={() => setFilter(f.value)}
            >
              {f.label} ({count})
            </button>
          );
        })}
      </div>

      {error && (
        <div className={s.error}>
          <AlertCircle size={14} style={{ verticalAlign: 'middle', marginRight: 6 }} />
          {error?.message ?? 'Could not load staff.'}
        </div>
      )}

      {loading ? (
        <div className={s.empty}>Loading staff…</div>
      ) : filteredStaff.length === 0 ? (
        <div className={s.empty}>
          <div className={s.emptyTitle}>
            {filter === 'all' ? 'No staff records yet' : `No ${filter} staff`}
          </div>
          <div style={{ marginBottom: readOnly ? 0 : 14 }}>
            {filter === 'all' && !readOnly && (
              'Start by adding the team. Each staff member needs an email + hire date for the Executive module to anchor lifecycle tasks correctly.'
            )}
            {filter !== 'all' && (
              `Switch to "All" to see ${filter === 'active' ? 'inactive' : 'active'} records.`
            )}
          </div>
          {filter === 'all' && !readOnly && (
            <button
              type="button"
              className={s.primaryBtn}
              onClick={() => setEditing({ mode: 'create' })}
              disabled={submitting}
            >
              <Plus size={14} />
              Add first staff member
            </button>
          )}
        </div>
      ) : (
        <div className={s.staffList}>
          {filteredStaff.map((m) => (
            <StaffRow
              key={m.id}
              member={m}
              readOnly={readOnly}
              submitting={submitting}
              onEdit={() => setEditing({ mode: 'edit', staff: m })}
              onDelete={() => handleDelete(m)}
            />
          ))}
        </div>
      )}

      {editing && (
        <Modal
          title={editing.mode === 'edit'
            ? `Edit ${editing.staff.first_name}${editing.staff.last_name ? ' ' + editing.staff.last_name : ''}`
            : 'Add staff member'}
          onClose={() => setEditing(null)}
        >
          <StaffForm
            initial={editing.staff}
            submitting={submitting}
            onCancel={() => setEditing(null)}
            onSave={handleSave}
          />
        </Modal>
      )}
    </div>
  );
}

function StaffRow({ member, readOnly, submitting, onEdit, onDelete }) {
  const tenure = yearsAt(member.hire_date);
  const fullName = `${member.first_name}${member.last_name ? ' ' + member.last_name : ''}`;

  return (
    <div className={s.staffRow}>
      <div>
        <h3 className={s.staffName}>
          {fullName}
          {member.active ? (
            <span className={s.activeBadge}>active</span>
          ) : (
            <span className={s.inactiveBadge}>inactive</span>
          )}
          {member.role_title && (
            <span className={s.staffEmail} style={{ fontWeight: 500 }}>
              · {member.role_title}
            </span>
          )}
        </h3>
        <p className={s.staffEmail}>
          <Mail size={11} style={{ verticalAlign: 'middle', marginRight: 4 }} />
          {member.email}
        </p>
      </div>

      <div className={s.staffDetails}>
        <div className={s.staffDetailsRow}>
          <Calendar size={11} />
          <span>Hired {fmtDate(member.hire_date)}{tenure && ` · ${tenure}`}</span>
        </div>
        {member.end_date && (
          <div className={s.staffDetailsRow}>
            <UserX size={11} />
            <span>Ended {fmtDate(member.end_date)}</span>
          </div>
        )}
        {member.manager_email && (
          <div className={s.staffDetailsRow}>
            <Briefcase size={11} />
            <span>Reports to {member.manager_email}</span>
          </div>
        )}
      </div>

      {!readOnly && (
        <div className={s.staffActions}>
          <button
            type="button"
            className={s.iconBtn}
            onClick={onEdit}
            disabled={submitting}
            aria-label="Edit staff member"
            title="Edit"
          >
            <Pencil size={16} />
          </button>
          <button
            type="button"
            className={`${s.iconBtn} ${s.danger}`}
            onClick={onDelete}
            disabled={submitting}
            aria-label="Delete staff member"
            title="Delete (use Inactive instead for past employees)"
          >
            <Trash2 size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
