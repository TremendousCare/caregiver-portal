import { useState, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { EMPLOYMENT_STATUSES, AVAILABILITY_TYPES } from '../../lib/constants';
import { getExpiryStatus } from '../../lib/rosterUtils';
import layout from '../../styles/layout.module.css';

// ─── Inline Editable Cell ───
function InlineSelect({ value, options, onChange }) {
  return (
    <select
      value={value || ''}
      onChange={(e) => onChange(e.target.value)}
      style={{
        padding: '4px 8px', borderRadius: 6, border: '1px solid #E5E7EB',
        fontSize: 13, fontFamily: 'inherit', background: '#fff', cursor: 'pointer',
        color: '#0F1724', fontWeight: 500,
      }}
    >
      <option value="">—</option>
      {options.map((opt) => (
        <option key={opt.id} value={opt.id}>{opt.label}</option>
      ))}
    </select>
  );
}

function InlineText({ value, placeholder, onSave }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value || '');

  const commit = () => {
    if (draft !== (value || '')) onSave(draft);
    setEditing(false);
  };

  if (!editing) {
    return (
      <span
        onClick={() => { setDraft(value || ''); setEditing(true); }}
        style={{
          cursor: 'pointer', color: value ? '#0F1724' : '#9CA3AF',
          fontSize: 13, fontWeight: 500, display: 'inline-block', minWidth: 80,
          padding: '4px 8px', borderRadius: 6,
          border: '1px solid transparent',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.border = '1px solid #E5E7EB'; }}
        onMouseLeave={(e) => { e.currentTarget.style.border = '1px solid transparent'; }}
        title="Click to edit"
      >
        {value || placeholder || 'Click to set'}
      </span>
    );
  }

  return (
    <input
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false); }}
      placeholder={placeholder}
      style={{
        padding: '4px 8px', borderRadius: 6, border: '1px solid #29BEE4',
        fontSize: 13, fontFamily: 'inherit', width: '100%', minWidth: 120,
        outline: 'none', fontWeight: 500,
      }}
    />
  );
}

function ExpiryBadge({ dateStr }) {
  const status = getExpiryStatus(dateStr);
  return (
    <span style={{
      fontSize: 12, fontWeight: 600, color: status.color,
      padding: '2px 8px', borderRadius: 6,
      background: status.level === 'expired' ? '#FEF2F2' : status.level === 'warning' ? '#FFFBEB' : status.level === 'ok' ? '#F0FDF4' : '#F3F4F6',
    }}>
      {status.label}
    </span>
  );
}

// ─── Main Component ───
export function ActiveRoster({ caregivers, onUpdateCaregiver }) {
  const navigate = useNavigate();
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [availabilityFilter, setAvailabilityFilter] = useState('all');

  // Roster statuses (exclude 'onboarding' from filter options)
  const rosterStatuses = EMPLOYMENT_STATUSES.filter((s) => s.id !== 'onboarding');

  const filtered = useMemo(() => {
    return caregivers.filter((cg) => {
      const matchSearch = !searchTerm ||
        `${cg.firstName} ${cg.lastName}`.toLowerCase().includes(searchTerm.toLowerCase()) ||
        cg.phone?.includes(searchTerm) ||
        cg.currentAssignment?.toLowerCase().includes(searchTerm.toLowerCase());
      const matchStatus = statusFilter === 'all' || cg.employmentStatus === statusFilter;
      const matchAvailability = availabilityFilter === 'all' || cg.availabilityType === availabilityFilter;
      return matchSearch && matchStatus && matchAvailability;
    });
  }, [caregivers, searchTerm, statusFilter, availabilityFilter]);

  const handleFieldUpdate = useCallback((cgId, field, value) => {
    onUpdateCaregiver(cgId, { [field]: value });
  }, [onUpdateCaregiver]);

  return (
    <div>
      {/* Header */}
      <div className={layout.header}>
        <div>
          <h1 className={layout.pageTitle}>Active Roster</h1>
          <p className={layout.pageSubtitle}>
            {caregivers.length} caregiver{caregivers.length !== 1 ? 's' : ''} on the roster
          </p>
        </div>
      </div>

      {/* Filters */}
      <div style={{
        display: 'flex', gap: 12, marginBottom: 24, flexWrap: 'wrap', alignItems: 'center',
      }}>
        <input
          type="text"
          placeholder="Search by name, phone, or assignment..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          style={{
            padding: '10px 16px', borderRadius: 10, border: '1px solid #E5E7EB',
            fontSize: 14, fontFamily: 'inherit', flex: '1 1 240px', minWidth: 200,
            outline: 'none', background: '#fff',
          }}
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          style={{
            padding: '10px 16px', borderRadius: 10, border: '1px solid #E5E7EB',
            fontSize: 13, fontFamily: 'inherit', background: '#fff', cursor: 'pointer',
            fontWeight: 500,
          }}
        >
          <option value="all">All Statuses</option>
          {rosterStatuses.map((s) => (
            <option key={s.id} value={s.id}>{s.label}</option>
          ))}
        </select>
        <select
          value={availabilityFilter}
          onChange={(e) => setAvailabilityFilter(e.target.value)}
          style={{
            padding: '10px 16px', borderRadius: 10, border: '1px solid #E5E7EB',
            fontSize: 13, fontFamily: 'inherit', background: '#fff', cursor: 'pointer',
            fontWeight: 500,
          }}
        >
          <option value="all">All Availability</option>
          {AVAILABILITY_TYPES.map((t) => (
            <option key={t.id} value={t.id}>{t.label}</option>
          ))}
        </select>
      </div>

      {/* Table */}
      {filtered.length === 0 ? (
        <div className={layout.emptyState}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>👥</div>
          <h3 style={{ color: '#0F1724', marginBottom: 8 }}>No caregivers on the roster yet</h3>
          <p style={{ color: '#7A8BA0', maxWidth: 400, margin: '0 auto' }}>
            Caregivers will appear here after they complete onboarding and are moved to the Active Roster.
          </p>
        </div>
      ) : (
        <div style={{
          background: '#fff', borderRadius: 16, border: '1px solid rgba(0,0,0,0.06)',
          boxShadow: '0 2px 8px rgba(0,0,0,0.03)', overflow: 'hidden',
        }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#F9FAFB', borderBottom: '1px solid #E5E7EB' }}>
                {['Name', 'Phone', 'Status', 'Availability', 'Current Assignment', 'HCA Expiry', 'CPR Expiry'].map((h) => (
                  <th key={h} style={{
                    padding: '12px 16px', textAlign: 'left', fontWeight: 700,
                    fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.8px',
                    color: '#6B7280',
                  }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((cg) => (
                <tr
                  key={cg.id}
                  style={{ borderBottom: '1px solid #F3F4F6', transition: 'background 0.1s' }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = '#F9FAFB'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                >
                  <td style={{ padding: '12px 16px' }}>
                    <button
                      onClick={() => navigate(`/caregiver/${cg.id}`)}
                      style={{
                        background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                        fontFamily: 'inherit', textAlign: 'left',
                      }}
                    >
                      <div style={{ fontWeight: 600, color: '#0F1724', fontSize: 14 }}>
                        {cg.firstName} {cg.lastName}
                      </div>
                      {cg.email && (
                        <div style={{ fontSize: 12, color: '#9CA3AF', marginTop: 2 }}>{cg.email}</div>
                      )}
                    </button>
                  </td>
                  <td style={{ padding: '12px 16px', color: '#374151', fontWeight: 500 }}>
                    {cg.phone || '—'}
                  </td>
                  <td style={{ padding: '12px 16px' }}>
                    <InlineSelect
                      value={cg.employmentStatus}
                      options={rosterStatuses}
                      onChange={(val) => handleFieldUpdate(cg.id, 'employmentStatus', val)}
                    />
                  </td>
                  <td style={{ padding: '12px 16px' }}>
                    <InlineSelect
                      value={cg.availabilityType}
                      options={AVAILABILITY_TYPES}
                      onChange={(val) => handleFieldUpdate(cg.id, 'availabilityType', val)}
                    />
                  </td>
                  <td style={{ padding: '12px 16px' }}>
                    <InlineText
                      value={cg.currentAssignment}
                      placeholder="Not assigned"
                      onSave={(val) => handleFieldUpdate(cg.id, 'currentAssignment', val)}
                    />
                  </td>
                  <td style={{ padding: '12px 16px' }}>
                    <ExpiryBadge dateStr={cg.hcaExpiration} />
                  </td>
                  <td style={{ padding: '12px 16px' }}>
                    <ExpiryBadge dateStr={cg.cprExpiryDate} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
