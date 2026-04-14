import { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { EMPLOYMENT_STATUSES, AVAILABILITY_TYPES } from '../../lib/constants';
import { getExpiryStatus } from '../../lib/rosterUtils';
import { resolveCaregiverMergeFields, normalizePhone } from '../../lib/mergeFields';
import { supabase } from '../../lib/supabase';
import { useCommunicationRoutes } from '../../shared/hooks/useCommunicationRoutes';
import { RouteSelectorChip, RouteSummaryLine } from '../../shared/components/RouteSelectorChip';
import layout from '../../styles/layout.module.css';
import d from './Dashboard.module.css';

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

// Archive reasons for active roster caregivers
const ROSTER_ARCHIVE_REASONS = [
  { value: 'resigned', label: 'Resigned' },
  { value: 'terminated', label: 'Terminated' },
  { value: 'retired', label: 'Retired' },
  { value: 'on_leave', label: 'On Leave (Extended)' },
  { value: 'other', label: 'Other' },
];

// ─── Main Component ───
export function ActiveRoster({ caregivers, onUpdateCaregiver, onBulkSms, onBulkAddNote, onBulkArchive, showToast, sidebarWidth }) {
  const navigate = useNavigate();
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [availabilityFilter, setAvailabilityFilter] = useState('all');

  // Bulk action state
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [bulkAction, setBulkAction] = useState(null); // "note" | "archive" | "sms"
  const [bulkNoteText, setBulkNoteText] = useState('');

  // SMS bulk state
  const [bulkSmsText, setBulkSmsText] = useState('');
  const [smsTemplates, setSmsTemplates] = useState([]);
  const [selectedSmsTemplate, setSelectedSmsTemplate] = useState('');
  const [smsSendStep, setSmsSendStep] = useState('compose');
  const [isSending, setIsSending] = useState(false);

  // Communication route selection for bulk SMS
  const { routes, showSelector: showRouteSelector, smartDefaultCategoryFor, isRouteConfigured } = useCommunicationRoutes();
  const [smsCategory, setSmsCategory] = useState(null);
  const [smsCategoryTouched, setSmsCategoryTouched] = useState(false);

  // Load SMS templates
  useEffect(() => {
    if (!supabase) return;
    supabase.from('app_settings').select('value').eq('key', 'sms_templates').single()
      .then(({ data }) => {
        if (data?.value) {
          const parsed = typeof data.value === 'string' ? JSON.parse(data.value) : data.value;
          setSmsTemplates(Array.isArray(parsed) ? parsed : []);
        }
      })
      .catch(() => {});
  }, []);

  // Clear selection when filters change
  useEffect(() => {
    setSelectedIds(new Set());
    setBulkAction(null);
  }, [searchTerm, statusFilter, availabilityFilter]);

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

  const selectionMode = selectedIds.size > 0;

  // Seed the SMS category smart default as selection changes, until the user
  // explicitly picks a route via the chip.
  useEffect(() => {
    if (smsCategoryTouched) return;
    if (!showRouteSelector) return;
    const selectedCgs = filtered.filter((cg) => selectedIds.has(cg.id));
    const next = smartDefaultCategoryFor(selectedCgs);
    if (next && next !== smsCategory) setSmsCategory(next);
  }, [selectedIds, filtered, smartDefaultCategoryFor, showRouteSelector, smsCategoryTouched, smsCategory]);

  // Reset the touched flag when the panel closes so next open re-applies default
  useEffect(() => {
    if (smsSendStep === 'compose' && selectedIds.size === 0) {
      setSmsCategoryTouched(false);
    }
  }, [smsSendStep, selectedIds.size]);

  const toggleSelect = useCallback((id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAll = () => {
    setSelectedIds(new Set(filtered.map((cg) => cg.id)));
  };

  const clearSelection = () => {
    setSelectedIds(new Set());
    setBulkAction(null);
    setBulkNoteText('');
    setBulkSmsText('');
    setSelectedSmsTemplate('');
    setSmsSendStep('compose');
  };

  const handleFieldUpdate = useCallback((cgId, field, value) => {
    onUpdateCaregiver(cgId, { [field]: value });
  }, [onUpdateCaregiver]);

  const handleHeaderCheckbox = () => {
    if (selectedIds.size === filtered.length) {
      setSelectedIds(new Set());
    } else {
      selectAll();
    }
  };

  const thStyle = {
    padding: '12px 16px', textAlign: 'left', fontWeight: 700,
    fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.8px',
    color: '#6B7280',
  };

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

      {/* Selection hint bar */}
      {filtered.length > 0 && (
        <div className={d.selectionBar}>
          <div className={d.selectionLeft}>
            {selectionMode ? (
              <>
                <span className={d.selectionCount}>
                  {selectedIds.size} selected
                </span>
                {selectedIds.size < filtered.length && (
                  <button className={d.selectAllLink} onClick={selectAll}>
                    Select all {filtered.length}
                  </button>
                )}
                <button className={d.clearLink} onClick={clearSelection}>
                  Clear
                </button>
              </>
            ) : (
              <span className={d.selectHint}>
                Click checkboxes to select caregivers for bulk actions
              </span>
            )}
          </div>
        </div>
      )}

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
                <th style={{ ...thStyle, width: 44, textAlign: 'center', padding: '12px 8px' }}>
                  <input
                    type="checkbox"
                    checked={selectedIds.size === filtered.length && filtered.length > 0}
                    onChange={handleHeaderCheckbox}
                    style={{ cursor: 'pointer', width: 16, height: 16, accentColor: '#2E4E8D' }}
                  />
                </th>
                {['Name', 'Phone', 'Status', 'Availability', 'Current Assignment', 'HCA Expiry', 'CPR Expiry'].map((h) => (
                  <th key={h} style={thStyle}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((cg) => {
                const isSelected = selectedIds.has(cg.id);
                return (
                  <tr
                    key={cg.id}
                    style={{
                      borderBottom: '1px solid #F3F4F6', transition: 'background 0.1s',
                      background: isSelected ? '#F0F4FA' : 'transparent',
                    }}
                    onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = '#F9FAFB'; }}
                    onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}
                  >
                    <td style={{ padding: '12px 8px', textAlign: 'center' }}>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleSelect(cg.id)}
                        style={{ cursor: 'pointer', width: 16, height: 16, accentColor: '#2E4E8D' }}
                      />
                    </td>
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
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Bulk Action Bar — fixed at bottom when items are selected */}
      {selectionMode && (
        <div className={`tc-bulk-bar ${d.actionBar}`} style={{ left: sidebarWidth || 260 }}>
          <div className={d.actionBarInner}>
            <div className={d.actionBarLeft}>
              <span className={d.actionBarCount}>
                {selectedIds.size} caregiver{selectedIds.size !== 1 ? 's' : ''} selected
              </span>
            </div>

            <div className={d.actionBarActions}>
              {/* Send SMS */}
              <div className={d.actionGroup}>
                <button
                  className={`${d.actionBtn} ${bulkAction === 'sms' ? d.actionBtnActive : ''}`}
                  onClick={() => { setBulkAction(bulkAction === 'sms' ? null : 'sms'); setSmsSendStep('compose'); }}
                >
                  💬 Send SMS
                </button>
                {bulkAction === 'sms' && (() => {
                  const selectedCgs = filtered.filter((cg) => selectedIds.has(cg.id));
                  const withPhone = selectedCgs.filter((cg) => normalizePhone(cg.phone) !== null);
                  const withoutPhone = selectedCgs.length - withPhone.length;
                  const selectedRoute = showRouteSelector
                    ? routes.find((r) => r.category === smsCategory) || null
                    : null;

                  if (smsSendStep === 'confirm') {
                    const previewCg = withPhone[0];
                    const previewText = previewCg ? resolveCaregiverMergeFields(bulkSmsText, previewCg) : bulkSmsText;
                    return (
                      <div className={`${d.actionDropdown} ${d.actionDropdownXWide}`}>
                        <div className={d.confirmPanel}>
                          <div className={d.confirmSummary}>
                            Send SMS to <strong>{withPhone.length}</strong> caregiver{withPhone.length !== 1 ? 's' : ''} with valid phone numbers
                          </div>
                          {withoutPhone > 0 && (
                            <div className={d.confirmSkipped}>
                              {withoutPhone} will be skipped (no phone number)
                            </div>
                          )}
                          {showRouteSelector && <RouteSummaryLine route={selectedRoute} />}
                          <div className={d.confirmPreviewLabel}>Preview ({previewCg ? `${previewCg.firstName} ${previewCg.lastName}` : ''})</div>
                          <div className={d.confirmPreviewBox}>{previewText}</div>
                          <div className={d.composeActions}>
                            <button className={d.backBtn} onClick={() => setSmsSendStep('compose')}>← Back</button>
                            <button
                              className={d.sendBtn}
                              disabled={isSending || withPhone.length === 0}
                              onClick={async () => {
                                setIsSending(true);
                                try {
                                  const result = await onBulkSms([...selectedIds], bulkSmsText.trim(), showRouteSelector ? smsCategory : undefined);
                                  const { sent = 0, skipped = 0, failed = 0 } = result || {};
                                  let msg = `SMS sent to ${sent} caregiver${sent !== 1 ? 's' : ''}`;
                                  if (skipped > 0) msg += `, ${skipped} skipped`;
                                  if (failed > 0) msg += `, ${failed} failed`;
                                  showToast(msg);
                                  clearSelection();
                                } catch (err) {
                                  showToast(`Failed to send SMS: ${err.message || 'Unknown error'}`);
                                } finally {
                                  setIsSending(false);
                                }
                              }}
                            >
                              {isSending ? 'Sending...' : `Send to ${withPhone.length} caregiver${withPhone.length !== 1 ? 's' : ''}`}
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  }

                  return (
                    <div className={`${d.actionDropdown} ${d.actionDropdownXWide}`}>
                      <div style={{ padding: '8px 12px 4px', fontSize: 12, color: '#6B7B8F', borderBottom: '1px solid #E5E7EB', marginBottom: 8 }}>
                        Send SMS to {selectedIds.size} caregiver{selectedIds.size !== 1 ? 's' : ''}
                      </div>
                      {smsTemplates.length > 0 && (
                        <select
                          className={d.dropdownInput}
                          value={selectedSmsTemplate}
                          onChange={(e) => {
                            setSelectedSmsTemplate(e.target.value);
                            if (e.target.value) {
                              const tpl = smsTemplates.find((t) => t.id === e.target.value);
                              if (tpl) setBulkSmsText(tpl.body);
                            }
                          }}
                          style={{ marginBottom: 8 }}
                        >
                          <option value="">-- Pick a template (optional) --</option>
                          {smsTemplates.map((t) => (
                            <option key={t.id} value={t.id}>{t.name}</option>
                          ))}
                        </select>
                      )}
                      <textarea
                        className={d.composeTextarea}
                        placeholder="Type your SMS message... Use {{first_name}}, {{last_name}} for merge fields"
                        value={bulkSmsText}
                        onChange={(e) => setBulkSmsText(e.target.value)}
                        rows={4}
                        autoFocus
                      />
                      <div className={d.mergeFieldsHint}>
                        Merge fields: {'{{first_name}}'}, {'{{last_name}}'}, {'{{phone}}'}, {'{{email}}'}
                      </div>
                      <div className={withPhone.length > 0 ? d.phoneCountLine : `${d.phoneCountLine} ${d.phoneCountWarning}`}>
                        {withPhone.length} of {selectedCgs.length} have a valid phone number
                        {withoutPhone > 0 && ` · ${withoutPhone} will be skipped`}
                      </div>
                      {showRouteSelector && (
                        <RouteSelectorChip
                          routes={routes}
                          isRouteConfigured={isRouteConfigured}
                          value={smsCategory}
                          onChange={(cat) => {
                            setSmsCategory(cat);
                            setSmsCategoryTouched(true);
                          }}
                          disabled={isSending}
                        />
                      )}
                      <div className={d.composeActions}>
                        <button
                          className={d.sendBtn}
                          disabled={!bulkSmsText.trim() || withPhone.length === 0}
                          onClick={() => setSmsSendStep('confirm')}
                        >
                          Review & Send →
                        </button>
                      </div>
                    </div>
                  );
                })()}
              </div>

              {/* Add Note */}
              <div className={d.actionGroup}>
                <button
                  className={`${d.actionBtn} ${bulkAction === 'note' ? d.actionBtnActive : ''}`}
                  onClick={() => setBulkAction(bulkAction === 'note' ? null : 'note')}
                >
                  📝 Add Note
                </button>
                {bulkAction === 'note' && (
                  <div className={`${d.actionDropdown} ${d.actionDropdownWide}`}>
                    <input
                      className={d.dropdownInput}
                      placeholder="Note for all selected caregivers..."
                      value={bulkNoteText}
                      onChange={(e) => setBulkNoteText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && bulkNoteText.trim()) {
                          onBulkAddNote([...selectedIds], bulkNoteText.trim());
                          setBulkNoteText('');
                          clearSelection();
                        }
                      }}
                      autoFocus
                    />
                    <button
                      className={d.dropdownApply}
                      onClick={() => {
                        if (bulkNoteText.trim()) {
                          onBulkAddNote([...selectedIds], bulkNoteText.trim());
                          setBulkNoteText('');
                          clearSelection();
                        }
                      }}
                    >
                      Add to {selectedIds.size} caregiver{selectedIds.size !== 1 ? 's' : ''}
                    </button>
                  </div>
                )}
              </div>

              {/* Archive */}
              <div className={d.actionGroup}>
                <button
                  className={`${d.actionBtn} ${bulkAction === 'archive' ? d.actionBtnActive : ''} ${bulkAction !== 'archive' ? d.actionBtnArchive : ''}`}
                  onClick={() => setBulkAction(bulkAction === 'archive' ? null : 'archive')}
                >
                  📦 Archive
                </button>
                {bulkAction === 'archive' && (
                  <div className={d.actionDropdown} style={{ minWidth: 240 }}>
                    <div style={{ padding: '8px 12px', fontSize: 12, color: '#6B7B8F', borderBottom: '1px solid #E5E7EB' }}>
                      Archive {selectedIds.size} caregiver{selectedIds.size !== 1 ? 's' : ''} as:
                    </div>
                    {ROSTER_ARCHIVE_REASONS.map((r) => (
                      <button
                        key={r.value}
                        className={d.dropdownItem}
                        onClick={() => {
                          onBulkArchive([...selectedIds], r.value);
                          clearSelection();
                        }}
                      >
                        {r.label}
                      </button>
                    ))}
                    <button
                      className={d.dropdownCancel}
                      onClick={() => setBulkAction(null)}
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            </div>

            <button className={d.actionBarClose} onClick={clearSelection}>
              ✕
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
