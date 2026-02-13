import { useState, useEffect, useMemo } from 'react';
import { PHASES, CHASE_SCRIPTS, GREEN_LIGHT_ITEMS, DOCUMENT_TYPES } from '../lib/constants';
import { getCurrentPhase, getCalculatedPhase, getOverallProgress, getPhaseProgress, getDaysSinceApplication, isGreenLight, isTaskDone } from '../lib/utils';
import { getPhaseTasks } from '../lib/storage';
import { OrientationBanner } from './KanbanBoard';
import { styles, taskEditStyles } from '../styles/theme';
import { supabase } from '../lib/supabase';

function EditField({ label, value, onChange, type = 'text' }) {
  return (
    <div style={styles.field}>
      <label style={styles.fieldLabel}>{label}</label>
      <input style={styles.fieldInput} type={type} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

const ARCHIVE_REASONS = [
  { value: 'hired', label: 'Hired & Deployed' },
  { value: 'declined_offer', label: 'Declined Offer' },
  { value: 'ghosted', label: 'Ghosted / No Response' },
  { value: 'failed_background', label: 'Failed Background Check' },
  { value: 'withdrew', label: 'Candidate Withdrew' },
  { value: 'no_show', label: 'No-Show to Interview/Orientation' },
  { value: 'not_qualified', label: 'Did Not Meet Requirements' },
  { value: 'duplicate', label: 'Duplicate Entry' },
  { value: 'other', label: 'Other' },
];

const NOTE_TYPES = [
  { value: 'note', label: 'Internal Note', icon: '📝' },
  { value: 'call', label: 'Phone Call', icon: '📞' },
  { value: 'text', label: 'Text Message', icon: '💬' },
  { value: 'email', label: 'Email', icon: '✉️' },
  { value: 'voicemail', label: 'Voicemail', icon: '📱' },
];

const NOTE_OUTCOMES = [
  { value: 'connected', label: 'Connected' },
  { value: 'no_answer', label: 'No Answer' },
  { value: 'left_vm', label: 'Left Voicemail' },
  { value: 'responded', label: 'Responded' },
  { value: 'no_response', label: 'No Response' },
];

export function CaregiverDetail({
  caregiver, allCaregivers, currentUser, onBack, onUpdateTask, onUpdateTasksBulk,
  onAddNote, onArchive, onUnarchive, onDelete, onUpdateCaregiver, onRefreshTasks,
  showScripts, setShowScripts, showGreenLight, setShowGreenLight,
}) {
  const [noteText, setNoteText] = useState('');
  const [noteType, setNoteType] = useState('note');
  const [noteDirection, setNoteDirection] = useState('outbound');
  const [noteOutcome, setNoteOutcome] = useState('');
  const [activePhase, setActivePhase] = useState(getCurrentPhase(caregiver));
  const [showArchiveDialog, setShowArchiveDialog] = useState(false);
  const [archiveReason, setArchiveReason] = useState('');
  const [archiveDetail, setArchiveDetail] = useState('');
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState({});
  const [editingTasks, setEditingTasks] = useState(false);
  const [taskDraft, setTaskDraft] = useState([]);
  const [rcData, setRcData] = useState({ sms: [], calls: [] });
  const [rcLoading, setRcLoading] = useState(false);
  const [showPortalOnly, setShowPortalOnly] = useState(false);
  const [documents, setDocuments] = useState([]);
  const [docsLoading, setDocsLoading] = useState(false);
  const [uploadingDoc, setUploadingDoc] = useState(null);
  const [docsExpanded, setDocsExpanded] = useState(() => localStorage.getItem('tc_docs_expanded') === 'true');

  const overallPct = getOverallProgress(caregiver);
  const greenLight = isGreenLight(caregiver);
  const days = getDaysSinceApplication(caregiver);
  const PHASE_TASKS = getPhaseTasks();

  // Fetch RingCentral communication data
  useEffect(() => {
    if (!caregiver?.id || !supabase) return;
    let cancelled = false;
    setRcLoading(true);
    supabase.functions.invoke('get-communications', {
      body: { caregiver_id: caregiver.id, days_back: 90 },
    }).then(({ data, error }) => {
      if (cancelled) return;
      if (error || !data) {
        console.warn('RC fetch failed:', error);
        setRcData({ sms: [], calls: [] });
      } else {
        setRcData({ sms: data.sms || [], calls: data.calls || [] });
      }
    }).catch((err) => {
      if (!cancelled) {
        console.warn('RC fetch error:', err);
        setRcData({ sms: [], calls: [] });
      }
    }).finally(() => {
      if (!cancelled) setRcLoading(false);
    });
    return () => { cancelled = true; };
  }, [caregiver?.id]);

  // Fetch documents from caregiver_documents table
  const fetchDocuments = async () => {
    if (!caregiver?.id || !supabase) return;
    setDocsLoading(true);
    try {
      const { data, error } = await supabase
        .from('caregiver_documents')
        .select('*')
        .eq('caregiver_id', caregiver.id)
        .order('uploaded_at', { ascending: false });
      if (!error && data) setDocuments(data);
    } catch (err) {
      console.warn('Documents fetch error:', err);
    } finally {
      setDocsLoading(false);
    }
  };

  useEffect(() => { fetchDocuments(); }, [caregiver?.id]);

  // Handle document upload
  const handleDocUpload = async (docType, file) => {
    if (!file || !supabase) return;
    setUploadingDoc(docType);
    try {
      const reader = new FileReader();
      const base64 = await new Promise((resolve, reject) => {
        reader.onload = () => {
          const result = reader.result;
          const base64Data = result.split(',')[1];
          resolve(base64Data);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

      const { data, error } = await supabase.functions.invoke('sharepoint-docs', {
        body: {
          action: 'upload_file',
          caregiver_id: caregiver.id,
          document_type: docType,
          file_name: file.name,
          file_content_base64: base64,
          uploaded_by: currentUser?.email || '',
        },
      });

      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      // Refresh documents list and caregiver data (task may have been auto-completed)
      await fetchDocuments();
      if (onUpdateCaregiver) {
        // Trigger a refresh of the caregiver data to pick up task changes
        const { data: updated } = await supabase
          .from('caregivers')
          .select('tasks')
          .eq('id', caregiver.id)
          .single();
        if (updated?.tasks) {
          onUpdateCaregiver(caregiver.id, { tasks: updated.tasks });
        }
      }
    } catch (err) {
      console.error('Upload failed:', err);
      alert(`Upload failed: ${err.message || 'Unknown error'}`);
    } finally {
      setUploadingDoc(null);
    }
  };

  // Handle document download
  const handleDocDownload = async (docId) => {
    if (!supabase) return;
    try {
      const { data, error } = await supabase.functions.invoke('sharepoint-docs', {
        body: { action: 'get_download_url', doc_id: docId },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      if (data?.download_url) window.open(data.download_url, '_blank');
    } catch (err) {
      console.error('Download failed:', err);
      alert(`Download failed: ${err.message || 'Unknown error'}`);
    }
  };

  // Handle document view (opens SharePoint web URL)
  const handleDocView = (webUrl) => {
    if (webUrl) window.open(webUrl, '_blank');
  };

  // Handle document delete
  const handleDocDelete = async (docId, docName) => {
    if (!confirm(`Delete "${docName}"? This will remove it from SharePoint and the portal.`)) return;
    try {
      const { data, error } = await supabase.functions.invoke('sharepoint-docs', {
        body: { action: 'delete_file', doc_id: docId },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      await fetchDocuments();
      // Refresh caregiver tasks
      const { data: updated } = await supabase
        .from('caregivers')
        .select('tasks')
        .eq('id', caregiver.id)
        .single();
      if (updated?.tasks && onUpdateCaregiver) {
        onUpdateCaregiver(caregiver.id, { tasks: updated.tasks });
      }
    } catch (err) {
      console.error('Delete failed:', err);
      alert(`Delete failed: ${err.message || 'Unknown error'}`);
    }
  };

  // Merge portal notes + RC data into unified timeline
  const mergedTimeline = useMemo(() => {
    // Portal notes
    const portalEntries = (caregiver.notes || []).map((n, i) => ({
      ...n,
      id: `portal-${i}`,
      source: n.source || 'portal',
      timestamp: n.timestamp || n.date,
    }));

    // RC entries
    const rcEntries = [...rcData.sms, ...rcData.calls];

    // Deduplication: skip RC outbound texts that match a portal note within 2 minutes
    const portalOutboundTexts = portalEntries.filter(
      (n) => n.type === 'text' && n.direction === 'outbound' && n.source === 'portal'
    );
    const deduped = rcEntries.filter((rc) => {
      if (rc.type !== 'text' || rc.direction !== 'outbound') return true;
      const rcTime = new Date(rc.timestamp).getTime();
      return !portalOutboundTexts.some((pn) => {
        const pnTime = new Date(pn.timestamp).getTime();
        return Math.abs(rcTime - pnTime) < 120000; // 2-minute window
      });
    });

    // Merge and sort newest first
    return [...portalEntries, ...deduped].sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );
  }, [caregiver.notes, rcData]);

  const startEditing = () => {
    setEditForm({
      firstName: caregiver.firstName || '', lastName: caregiver.lastName || '',
      phone: caregiver.phone || '', email: caregiver.email || '',
      address: caregiver.address || '', city: caregiver.city || '',
      state: caregiver.state || '', zip: caregiver.zip || '',
      perId: caregiver.perId || '', hcaExpiration: caregiver.hcaExpiration || '',
      hasHCA: caregiver.hasHCA || 'yes', hasDL: caregiver.hasDL || 'yes',
      availability: caregiver.availability || '', source: caregiver.source || '',
      sourceDetail: caregiver.sourceDetail || '',
      applicationDate: caregiver.applicationDate || '',
      yearsExperience: caregiver.yearsExperience || '',
      languages: caregiver.languages || '',
      specializations: caregiver.specializations || '',
      certifications: caregiver.certifications || '',
      preferredShift: caregiver.preferredShift || '',
      initialNotes: caregiver.initialNotes || '',
    });
    setEditing(true);
  };

  const saveEdits = () => { onUpdateCaregiver(caregiver.id, editForm); setEditing(false); };
  const editField = (field, value) => { setEditForm((f) => ({ ...f, [field]: value })); };
  const isCommunication = noteType !== 'note';
  const handleAddNote = () => {
    if (!noteText.trim()) return;
    const note = { text: noteText.trim(), type: noteType };
    if (isCommunication) {
      note.direction = noteDirection;
      if (noteOutcome) note.outcome = noteOutcome;
    }
    onAddNote(caregiver.id, note);
    setNoteText('');
    setNoteOutcome('');
  };

  return (
    <div>
      {/* Header */}
      <div style={styles.detailHeader}>
        <button style={styles.backBtn} onClick={onBack}>← Back</button>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
            <div style={styles.detailAvatar}>{caregiver.firstName?.[0]}{caregiver.lastName?.[0]}</div>
            <div>
              <h1 style={styles.detailName}>{caregiver.firstName} {caregiver.lastName}</h1>
              <div style={styles.detailMeta}>
                {caregiver.phone && <span>📞 {caregiver.phone}</span>}
                {caregiver.email && <span style={{ marginLeft: 16 }}>✉️ {caregiver.email}</span>}
                {caregiver.perId && <span style={{ marginLeft: 16 }}>🆔 PER {caregiver.perId}</span>}
              </div>
              {(caregiver.address || caregiver.city) && (
                <div style={{ ...styles.detailMeta, marginTop: 2 }}>
                  📍 {[caregiver.address, caregiver.city, caregiver.state, caregiver.zip].filter(Boolean).join(', ')}
                </div>
              )}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {greenLight && <span style={styles.greenLightBadgeLg}>🟢 Green Light</span>}
          {caregiver.archived && <span style={{ padding: '6px 14px', borderRadius: 8, background: '#FEF2F0', color: '#DC3545', fontWeight: 600, fontSize: 13 }}>Archived</span>}
          <button style={styles.greenLightBtn} onClick={() => setShowGreenLight(!showGreenLight)}>🛡️ Green Light Check</button>
          {!caregiver.archived ? (
            <button style={styles.dangerBtn} onClick={() => setShowArchiveDialog(true)}>📦 Archive</button>
          ) : (
            <button className="tc-btn-primary" style={styles.primaryBtn} onClick={() => onUnarchive(caregiver.id)}>↩️ Restore</button>
          )}
          <button style={{ ...styles.dangerBtn, background: '#7F1D1D', color: '#fff' }} onClick={() => setShowDeleteDialog(true)}>🗑️ Delete</button>
        </div>
      </div>

      {/* Archive Banner for archived caregivers */}
      {caregiver.archived && (
        <div style={{ background: '#FEF2F0', border: '1px solid #FECACA', borderRadius: 12, padding: '16px 20px', marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
            <span style={{ fontSize: 20 }}>📦</span>
            <strong style={{ color: '#DC3545', fontFamily: "'Outfit', sans-serif" }}>Archived Caregiver</strong>
          </div>
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', fontSize: 13, color: '#556270' }}>
            <div><span style={{ fontWeight: 600 }}>Reason:</span> {ARCHIVE_REASONS.find((r) => r.value === caregiver.archiveReason)?.label || caregiver.archiveReason || '—'}</div>
            {caregiver.archiveDetail && <div><span style={{ fontWeight: 600 }}>Detail:</span> {caregiver.archiveDetail}</div>}
            <div><span style={{ fontWeight: 600 }}>Phase at archive:</span> {PHASES.find((p) => p.id === caregiver.archivePhase)?.label || caregiver.archivePhase || '—'}</div>
            {caregiver.archivedAt && <div><span style={{ fontWeight: 600 }}>Archived:</span> {new Date(caregiver.archivedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}{caregiver.archivedBy ? ` by ${caregiver.archivedBy}` : ''}</div>}
          </div>
        </div>
      )}

      {/* Archive dialog */}
      {showArchiveDialog && (
        <div style={styles.alertCard}>
          <strong>Archive this caregiver?</strong>
          <p style={{ margin: '8px 0 12px', fontSize: 13, color: '#556270' }}>They'll be moved out of the active pipeline. You can restore them later.</p>
          <div style={{ marginBottom: 12 }}>
            <label style={styles.fieldLabel}>Reason <span style={{ color: '#DC3545' }}>*</span></label>
            <select style={styles.fieldInput} value={archiveReason} onChange={(e) => setArchiveReason(e.target.value)}>
              <option value="">Select a reason...</option>
              {ARCHIVE_REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </div>
          <div style={{ marginBottom: 12 }}>
            <label style={styles.fieldLabel}>Details (optional)</label>
            <input style={styles.fieldInput} placeholder="Any additional context..." value={archiveDetail} onChange={(e) => setArchiveDetail(e.target.value)} />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button style={{ ...styles.dangerBtn, opacity: archiveReason ? 1 : 0.5 }} disabled={!archiveReason} onClick={() => { onArchive(caregiver.id, archiveReason, archiveDetail); setShowArchiveDialog(false); }}>Archive</button>
            <button className="tc-btn-secondary" style={styles.secondaryBtn} onClick={() => { setShowArchiveDialog(false); setArchiveReason(''); setArchiveDetail(''); }}>Cancel</button>
          </div>
        </div>
      )}

      {/* Delete confirmation dialog */}
      {showDeleteDialog && (
        <div style={{ ...styles.alertCard, borderColor: '#DC2626', background: '#FEF2F2' }}>
          <strong style={{ color: '#991B1B' }}>Permanently delete this caregiver?</strong>
          <p style={{ margin: '8px 0 12px', fontSize: 13, color: '#7F1D1D' }}>
            This will permanently remove <strong>{caregiver.first_name} {caregiver.last_name}</strong> and all their data including notes, tasks, and activity history. This action cannot be undone.
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              style={{ ...styles.dangerBtn, background: '#DC2626', color: '#fff' }}
              onClick={() => { onDelete(caregiver.id); setShowDeleteDialog(false); }}
            >
              Delete Permanently
            </button>
            <button className="tc-btn-secondary" style={styles.secondaryBtn} onClick={() => setShowDeleteDialog(false)}>Cancel</button>
          </div>
        </div>
      )}

      {/* Green Light Checklist */}
      {showGreenLight && (
        <div style={styles.greenLightCard}>
          <h3 style={{ margin: '0 0 12px', color: '#1A1A1A', fontFamily: "'Outfit', sans-serif" }}>🛡️ Green Light Checklist</h3>
          <p style={{ margin: '0 0 16px', color: '#556270', fontSize: 13 }}>ALL items must be complete before scheduling Sunday Orientation.</p>
          {GREEN_LIGHT_ITEMS.map((item, i) => {
            const taskKeys = [
              ['offer_signed'],
              ['i9_form', 'w4_form', 'emergency_contact', 'employment_agreement'],
              ['background_check', 'hca_cleared'],
              ['tb_test'],
              ['training_assigned'],
            ];
            const done = taskKeys[i].every((k) => isTaskDone(caregiver.tasks?.[k]));
            return (
              <div key={i} style={styles.greenLightRow}>
                <span style={{ color: done ? '#5BA88B' : '#D4697A', fontSize: 18 }}>{done ? '✓' : '✗'}</span>
                <span style={{ color: done ? '#5BA88B' : '#6B7B8F' }}>{item}</span>
              </div>
            );
          })}
          <button style={{ ...styles.secondaryBtn, marginTop: 12 }} onClick={() => setShowGreenLight(false)}>Close</button>
        </div>
      )}

      {/* Profile Information */}
      <div style={styles.profileCard}>
        <div style={styles.profileCardHeader}>
          <h3 style={styles.profileCardTitle}>👤 Profile Information</h3>
          {!editing ? (
            <button style={styles.editBtn} onClick={startEditing}>✏️ Edit</button>
          ) : (
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="tc-btn-primary" style={styles.primaryBtn} onClick={saveEdits}>Save</button>
              <button className="tc-btn-secondary" style={styles.secondaryBtn} onClick={() => setEditing(false)}>Cancel</button>
            </div>
          )}
        </div>

        {!editing ? (
          <>
            <div style={styles.profileGrid}>
              {[
                { label: 'Full Name', value: `${caregiver.firstName} ${caregiver.lastName}` },
                { label: 'Phone', value: caregiver.phone },
                { label: 'Email', value: caregiver.email },
                { label: 'Address', value: (caregiver.address || caregiver.city) ? [caregiver.address, caregiver.city, caregiver.state, caregiver.zip].filter(Boolean).join(', ') : null },
                { label: 'HCA PER ID', value: caregiver.perId },
                { label: 'HCA Expiration Date', value: caregiver.hcaExpiration ? (() => { const exp = new Date(caregiver.hcaExpiration + 'T00:00:00'); const du = Math.ceil((exp - new Date()) / 86400000); const ds = exp.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }); if (du < 0) return `⚠️ Expired — ${ds}`; if (du <= 30) return `⏰ ${ds} (${du} days)`; if (du <= 90) return `📅 ${ds} (${du} days)`; return `✅ ${ds}`; })() : null },
                { label: 'HCA Status', value: caregiver.hasHCA === 'yes' ? '✅ Valid HCA ID' : caregiver.hasHCA === 'willing' ? '📝 Willing to register' : '❌ No HCA ID' },
                { label: "Driver's License & Car", value: caregiver.hasDL === 'yes' ? '✅ Yes' : '❌ No' },
                { label: 'Availability', value: caregiver.availability },
                { label: 'Source', value: [caregiver.source, caregiver.sourceDetail].filter(Boolean).join(' — ') || null },
                { label: 'Application Date', value: caregiver.applicationDate ? new Date(caregiver.applicationDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : null },
                { label: 'Days Since Application', value: `${days} day${days !== 1 ? 's' : ''}` },
                { label: 'Board Status', value: caregiver.boardStatus ? caregiver.boardStatus.charAt(0).toUpperCase() + caregiver.boardStatus.slice(1) : 'Not yet on board' },
                { label: 'Years of Experience', value: caregiver.yearsExperience ? ({ '0-1': 'Less than 1 year', '1-3': '1–3 years', '3-5': '3–5 years', '5-10': '5–10 years', '10+': '10+ years' }[caregiver.yearsExperience] || caregiver.yearsExperience) : null },
                { label: 'Preferred Shift', value: caregiver.preferredShift ? caregiver.preferredShift.charAt(0).toUpperCase() + caregiver.preferredShift.slice(1) : null },
                { label: 'Languages', value: caregiver.languages },
                { label: 'Specializations', value: caregiver.specializations },
                { label: 'Additional Certifications', value: caregiver.certifications },
                { label: 'Phase Override', value: caregiver.phaseOverride ? (() => { const p = PHASES.find((ph) => ph.id === caregiver.phaseOverride); return `⚙️ ${p?.icon} ${p?.label} (manual)`; })() : 'Auto (based on tasks)' },
              ].map((item) => (
                <div key={item.label} style={styles.profileItem}>
                  <div style={styles.profileLabel}>{item.label}</div>
                  <div style={styles.profileValue}>{item.value || '—'}</div>
                </div>
              ))}
            </div>
            {caregiver.initialNotes && (
              <div style={{ padding: '0 20px 16px' }}>
                <div style={styles.profileLabel}>Initial Notes</div>
                <div style={{ ...styles.profileValue, marginTop: 4 }}>{caregiver.initialNotes}</div>
              </div>
            )}
          </>
        ) : (
          <div style={{ padding: '16px 20px' }}>
            <div style={styles.formGrid}>
              <EditField label="First Name" value={editForm.firstName} onChange={(v) => editField('firstName', v)} />
              <EditField label="Last Name" value={editForm.lastName} onChange={(v) => editField('lastName', v)} />
              <EditField label="Phone" value={editForm.phone} onChange={(v) => editField('phone', v)} />
              <EditField label="Email" value={editForm.email} onChange={(v) => editField('email', v)} />
              <EditField label="Street Address" value={editForm.address} onChange={(v) => editField('address', v)} />
              <EditField label="City" value={editForm.city} onChange={(v) => editField('city', v)} />
              <EditField label="State" value={editForm.state} onChange={(v) => editField('state', v)} />
              <EditField label="Zip Code" value={editForm.zip} onChange={(v) => editField('zip', v)} />
              <EditField label="HCA PER ID" value={editForm.perId} onChange={(v) => editField('perId', v)} />
              <EditField label="HCA Expiration Date" value={editForm.hcaExpiration} onChange={(v) => editField('hcaExpiration', v)} type="date" />
              <div style={styles.field}>
                <label style={styles.fieldLabel}>HCA Status</label>
                <select style={styles.fieldInput} value={editForm.hasHCA} onChange={(e) => editField('hasHCA', e.target.value)}>
                  <option value="yes">Valid HCA ID</option><option value="no">No HCA ID</option><option value="willing">Willing to register</option>
                </select>
              </div>
              <div style={styles.field}>
                <label style={styles.fieldLabel}>Driver's License & Car</label>
                <select style={styles.fieldInput} value={editForm.hasDL} onChange={(e) => editField('hasDL', e.target.value)}>
                  <option value="yes">Yes</option><option value="no">No</option>
                </select>
              </div>
              <EditField label="Availability" value={editForm.availability} onChange={(v) => editField('availability', v)} />
              <div style={styles.field}>
                <label style={styles.fieldLabel}>Source</label>
                <select style={styles.fieldInput} value={editForm.source} onChange={(e) => editField('source', e.target.value)}>
                  <option>Indeed</option><option>Website</option><option>Referral</option><option>Craigslist</option><option>Facebook</option><option>Job Fair</option><option>Walk-In</option><option>Agency Transfer</option><option>Other</option>
                </select>
              </div>
              <EditField label={editForm.source === 'Referral' ? 'Referred By' : 'Source Details'} value={editForm.sourceDetail} onChange={(v) => editField('sourceDetail', v)} />
              <EditField label="Application Date" value={editForm.applicationDate} onChange={(v) => editField('applicationDate', v)} type="date" />
              <div style={styles.field}>
                <label style={styles.fieldLabel}>Years of Experience</label>
                <select style={styles.fieldInput} value={editForm.yearsExperience} onChange={(e) => editField('yearsExperience', e.target.value)}>
                  <option value="">Select...</option>
                  <option value="0-1">Less than 1 year</option>
                  <option value="1-3">1–3 years</option>
                  <option value="3-5">3–5 years</option>
                  <option value="5-10">5–10 years</option>
                  <option value="10+">10+ years</option>
                </select>
              </div>
              <div style={styles.field}>
                <label style={styles.fieldLabel}>Preferred Shift</label>
                <select style={styles.fieldInput} value={editForm.preferredShift} onChange={(e) => editField('preferredShift', e.target.value)}>
                  <option value="">Select...</option>
                  <option value="days">Days</option>
                  <option value="evenings">Evenings</option>
                  <option value="nights">Nights</option>
                  <option value="weekends">Weekends</option>
                  <option value="live-in">Live-In</option>
                  <option value="flexible">Flexible / Any</option>
                </select>
              </div>
              <EditField label="Languages Spoken" value={editForm.languages} onChange={(v) => editField('languages', v)} />
              <EditField label="Specializations" value={editForm.specializations} onChange={(v) => editField('specializations', v)} />
              <EditField label="Additional Certifications" value={editForm.certifications} onChange={(v) => editField('certifications', v)} />
            </div>
            <div style={{ marginTop: 16 }}>
              <label style={styles.fieldLabel}>Initial Notes</label>
              <textarea style={styles.textarea} rows={3} value={editForm.initialNotes} onChange={(e) => editField('initialNotes', e.target.value)} />
            </div>
          </div>
        )}
      </div>

      {/* Progress Overview */}
      <div style={styles.progressOverview}>
        <div style={styles.progressHeader}>
          <span style={styles.progressTitle}>Onboarding Progress</span>
          <span style={styles.progressPct}>{overallPct}%</span>
          <span style={styles.progressDays}>Day {days}</span>
        </div>
        <div style={styles.progressTrack}>
          <div className="tc-progress-fill" style={{ ...styles.progressFill, width: `${overallPct}%` }} />
        </div>

        {/* Phase Override */}
        {(() => {
          const calculated = getCalculatedPhase(caregiver);
          const isOverridden = !!caregiver.phaseOverride;
          const currentPhase = getCurrentPhase(caregiver);
          const currentPhaseInfo = PHASES.find((p) => p.id === currentPhase);
          return (
            <div style={styles.phaseOverrideRow}>
              <div style={styles.phaseOverrideLeft}>
                <span style={styles.phaseOverrideLabel}>Current Phase:</span>
                <span style={{ ...styles.phaseBadge, background: `${currentPhaseInfo.color}18`, color: currentPhaseInfo.color, border: `1px solid ${currentPhaseInfo.color}30` }}>
                  {currentPhaseInfo.icon} {currentPhaseInfo.label}
                </span>
                {isOverridden && <span style={styles.overrideBadge}>⚙️ Manual Override</span>}
              </div>
              <div style={styles.phaseOverrideRight}>
                <select style={styles.phaseOverrideSelect} value={caregiver.phaseOverride || ''}
                  onChange={(e) => {
                    const val = e.target.value;
                    if (val === '') { onUpdateCaregiver(caregiver.id, { phaseOverride: null }); }
                    else {
                      onUpdateCaregiver(caregiver.id, { phaseOverride: val, phaseTimestamps: { ...caregiver.phaseTimestamps, [val]: caregiver.phaseTimestamps?.[val] || Date.now() } });
                      setActivePhase(val);
                    }
                  }}
                >
                  <option value="">Auto (based on tasks)</option>
                  {PHASES.map((p) => <option key={p.id} value={p.id}>{p.icon} {p.label}{p.id === calculated ? ' ← calculated' : ''}</option>)}
                </select>
              </div>
            </div>
          );
        })()}

        <div style={styles.phaseNav}>
          {PHASES.map((p) => {
            const { pct } = getPhaseProgress(caregiver, p.id);
            return (
              <button key={p.id} style={{ ...styles.phaseTab, ...(activePhase === p.id ? { background: `${p.color}18`, borderColor: p.color, color: p.color } : {}) }} onClick={() => setActivePhase(p.id)}>
                <span>{p.icon}</span>
                <span style={styles.phaseTabLabel}>{p.short}</span>
                <span style={styles.phaseTabPct}>{pct}%</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Active Phase Detail */}
      <div style={styles.phaseDetail}>
        <div style={styles.phaseDetailHeader}>
          <div>
            <h2 style={styles.phaseDetailTitle}>{PHASES.find((p) => p.id === activePhase)?.icon} {PHASES.find((p) => p.id === activePhase)?.label}</h2>
            <p style={styles.phaseDetailSub}>{PHASES.find((p) => p.id === activePhase)?.description}</p>
          </div>
          {CHASE_SCRIPTS[activePhase] && (
            <button style={styles.scriptBtn} onClick={() => setShowScripts(showScripts === activePhase ? null : activePhase)}>
              📜 {showScripts === activePhase ? 'Hide' : 'Show'} Scripts
            </button>
          )}
        </div>

        {showScripts === activePhase && CHASE_SCRIPTS[activePhase] && (
          <div style={styles.scriptsPanel}>
            <h4 style={styles.scriptsPanelTitle}>{CHASE_SCRIPTS[activePhase].title}</h4>
            {CHASE_SCRIPTS[activePhase].scripts.map((s, i) => (
              <div key={i} style={styles.scriptRow}>
                <div style={styles.scriptDay}>{s.day}</div>
                <div style={{ flex: 1 }}>
                  <div style={styles.scriptAction}>{s.action}</div>
                  {s.script && <div style={styles.scriptText}>"{s.script}"</div>}
                </div>
              </div>
            ))}
          </div>
        )}

        {activePhase === 'orientation' && <OrientationBanner caregivers={allCaregivers} />}

        {/* Tasks header with bulk controls */}
        {(() => {
          const phaseTasks = PHASE_TASKS[activePhase];
          const allDone = phaseTasks.every((t) => isTaskDone(caregiver.tasks?.[t.id]));
          const noneDone = phaseTasks.every((t) => !isTaskDone(caregiver.tasks?.[t.id]));
          return (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: '#6B7B8F' }}>{editingTasks ? 'Editing Checklist' : 'Checklist'}</span>
              {!editingTasks ? (
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  {!allDone && <button style={styles.selectAllBtn} onClick={() => { const u = {}; phaseTasks.forEach((t) => { u[t.id] = true; }); onUpdateTasksBulk(caregiver.id, u); }}>✓ Select All</button>}
                  {!noneDone && <button style={styles.deselectAllBtn} onClick={() => { const u = {}; phaseTasks.forEach((t) => { u[t.id] = false; }); onUpdateTasksBulk(caregiver.id, u); }}>✗ Deselect All</button>}
                  <button style={styles.editBtn} onClick={() => { setTaskDraft(PHASE_TASKS[activePhase].map((t) => ({ ...t }))); setEditingTasks(true); }}>✏️ Edit Checklist</button>
                </div>
              ) : (
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="tc-btn-primary" style={styles.primaryBtn} onClick={() => { PHASE_TASKS[activePhase] = taskDraft.filter((t) => t.label.trim()); onRefreshTasks(); setEditingTasks(false); }}>Save</button>
                  <button className="tc-btn-secondary" style={styles.secondaryBtn} onClick={() => setEditingTasks(false)}>Cancel</button>
                </div>
              )}
            </div>
          );
        })()}

        {/* Task list */}
        {!editingTasks ? (
          <div style={styles.taskList}>
            {PHASE_TASKS[activePhase].map((task) => {
              const done = isTaskDone(caregiver.tasks?.[task.id]);
              return (
                <label key={task.id} className="tc-task-row" style={{ ...styles.taskRow, ...(done ? styles.taskRowDone : {}) }}>
                  <div className={done ? 'tc-checkbox-done' : ''} style={{ ...styles.checkbox, ...(done ? styles.checkboxDone : {}), ...(task.critical ? { borderColor: '#2E4E8D' } : {}) }} onClick={() => onUpdateTask(caregiver.id, task.id, !done)}>
                    {done && '✓'}
                  </div>
                  <div style={{ flex: 1 }}>
                    <span style={{ ...(done ? { textDecoration: 'line-through', opacity: 0.5 } : {}) }}>{task.label}</span>
                    {task.critical && !done && <span style={styles.criticalBadge}>Required</span>}
                  </div>
                </label>
              );
            })}
          </div>
        ) : (
          <div style={styles.taskList}>
            {taskDraft.map((task, idx) => (
              <div key={task.id} style={taskEditStyles.row}>
                <span style={taskEditStyles.handle}>⠿</span>
                <input style={taskEditStyles.input} value={task.label} onChange={(e) => setTaskDraft((prev) => prev.map((t, i) => i === idx ? { ...t, label: e.target.value } : t))} placeholder="Task description..." />
                <label style={taskEditStyles.criticalToggle} title="Mark as required">
                  <input type="checkbox" checked={!!task.critical} onChange={(e) => setTaskDraft((prev) => prev.map((t, i) => i === idx ? { ...t, critical: e.target.checked } : t))} />
                  <span style={taskEditStyles.criticalLabel}>Required</span>
                </label>
                <button style={taskEditStyles.moveBtn} disabled={idx === 0} onClick={() => setTaskDraft((prev) => { const arr = [...prev]; [arr[idx - 1], arr[idx]] = [arr[idx], arr[idx - 1]]; return arr; })}>↑</button>
                <button style={taskEditStyles.moveBtn} disabled={idx === taskDraft.length - 1} onClick={() => setTaskDraft((prev) => { const arr = [...prev]; [arr[idx], arr[idx + 1]] = [arr[idx + 1], arr[idx]]; return arr; })}>↓</button>
                <button style={taskEditStyles.deleteBtn} onClick={() => setTaskDraft((prev) => prev.filter((_, i) => i !== idx))}>✕</button>
              </div>
            ))}
            <button style={taskEditStyles.addBtn} onClick={() => setTaskDraft((prev) => [...prev, { id: 'custom_' + Date.now().toString(36), label: '', critical: false }])}>＋ Add Task</button>
          </div>
        )}
      </div>

      {/* Documents Section */}
      <div style={styles.profileCard}>
        <div
          style={{ ...styles.profileCardHeader, cursor: 'pointer', userSelect: 'none' }}
          onClick={() => { const next = !docsExpanded; setDocsExpanded(next); localStorage.setItem('tc_docs_expanded', String(next)); }}
        >
          <h3 style={styles.profileCardTitle}>
            <span style={{ display: 'inline-block', transition: 'transform 0.2s', transform: docsExpanded ? 'rotate(90deg)' : 'rotate(0deg)', marginRight: 6, fontSize: 12 }}>▶</span>
            📄 Documents
          </h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {docsLoading && (
              <span style={{ display: 'inline-block', width: 14, height: 14, border: '2px solid #D1D5DB', borderTopColor: '#2E4E8D', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
            )}
            <span style={{
              padding: '4px 10px', borderRadius: 10, fontSize: 12, fontWeight: 600,
              background: documents.length === DOCUMENT_TYPES.length ? '#DCFCE7' : '#FEF9C3',
              color: documents.length === DOCUMENT_TYPES.length ? '#166534' : '#854D0E',
            }}>
              {(() => {
                const uploadedTypes = new Set(documents.map((d) => d.document_type));
                return `${uploadedTypes.size} of ${DOCUMENT_TYPES.length} received`;
              })()}
            </span>
          </div>
        </div>

        {docsExpanded && <>
        {/* Progress bar */}
        {(() => {
          const uploadedTypes = new Set(documents.map((d) => d.document_type));
          const pct = Math.round((uploadedTypes.size / DOCUMENT_TYPES.length) * 100);
          return (
            <div style={{ padding: '0 20px 12px' }}>
              <div style={{ height: 6, background: '#E5E7EB', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${pct}%`, background: pct === 100 ? '#16A34A' : '#2E4E8D', borderRadius: 3, transition: 'width 0.3s ease' }} />
              </div>
            </div>
          );
        })()}

        {/* Document list */}
        <div style={{ padding: '0 20px 16px' }}>
          {DOCUMENT_TYPES.map((docType) => {
            const uploaded = documents.filter((d) => d.document_type === docType.id);
            const hasDoc = uploaded.length > 0;
            const isUploading = uploadingDoc === docType.id;
            return (
              <div key={docType.id} style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0',
                borderBottom: '1px solid #F0F0F0',
              }}>
                {/* Status icon */}
                <span style={{
                  width: 24, height: 24, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 13, fontWeight: 700, flexShrink: 0,
                  background: hasDoc ? '#DCFCE7' : '#FEE2E2',
                  color: hasDoc ? '#166534' : '#DC2626',
                }}>
                  {hasDoc ? '✓' : '—'}
                </span>

                {/* Doc info */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: '#1A1A1A' }}>{docType.label}</span>
                    {docType.required && !hasDoc && (
                      <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: '#FEE2E2', color: '#DC2626', fontWeight: 600 }}>Required</span>
                    )}
                  </div>
                  {hasDoc && uploaded.map((doc) => (
                    <div key={doc.id} style={{ fontSize: 12, color: '#6B7B8F', marginTop: 2, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{doc.file_name}</span>
                      <span>{new Date(doc.uploaded_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                      {doc.uploaded_by && <span>by {doc.uploaded_by.split('@')[0]}</span>}
                    </div>
                  ))}
                </div>

                {/* Action buttons */}
                <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                  {hasDoc && uploaded.map((doc) => (
                    <div key={doc.id} style={{ display: 'flex', gap: 4 }}>
                      {doc.sharepoint_web_url && (
                        <button
                          style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid #D1D5DB', background: '#FAFBFC', color: '#2E4E8D', fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
                          onClick={() => handleDocView(doc.sharepoint_web_url)}
                          title="View in SharePoint"
                        >View</button>
                      )}
                      <button
                        style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid #D1D5DB', background: '#FAFBFC', color: '#2E4E8D', fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
                        onClick={() => handleDocDownload(doc.id)}
                        title="Download file"
                      >Download</button>
                      <button
                        style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid #FCA5A5', background: '#FEF2F2', color: '#DC2626', fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
                        onClick={() => handleDocDelete(doc.id, doc.file_name)}
                        title="Delete document"
                      >✕</button>
                    </div>
                  ))}
                  {/* Upload button */}
                  <label style={{
                    padding: '4px 10px', borderRadius: 6, border: '1px solid #D1D5DB',
                    background: isUploading ? '#EBF0FA' : '#FAFBFC',
                    color: '#2E4E8D', fontSize: 11, fontWeight: 600, cursor: isUploading ? 'wait' : 'pointer', fontFamily: 'inherit',
                    display: 'flex', alignItems: 'center', gap: 4, opacity: isUploading ? 0.7 : 1,
                  }}>
                    {isUploading ? (
                      <>
                        <span style={{ display: 'inline-block', width: 10, height: 10, border: '2px solid #D1D5DB', borderTopColor: '#2E4E8D', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                        Uploading...
                      </>
                    ) : (
                      <>{hasDoc ? 'Replace' : 'Upload'}</>
                    )}
                    <input
                      type="file"
                      accept=".pdf,.doc,.docx,.jpg,.jpeg,.png"
                      style={{ display: 'none' }}
                      disabled={isUploading}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) handleDocUpload(docType.id, file);
                        e.target.value = '';
                      }}
                    />
                  </label>
                </div>
              </div>
            );
          })}
        </div>
        </>}
      </div>

      {/* Notes Section */}
      <div style={styles.notesSection}>
        <h3 style={styles.notesSectionTitle}>📝 Activity Log</h3>

        {/* Type selector pills */}
        <div style={{ display: 'flex', gap: 4, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          {NOTE_TYPES.map((t) => (
            <button
              key={t.value}
              style={{
                padding: '5px 12px', borderRadius: 20, border: '1px solid',
                borderColor: noteType === t.value ? '#2E4E8D' : '#D1D5DB',
                background: noteType === t.value ? '#EBF0FA' : '#FAFBFC',
                color: noteType === t.value ? '#2E4E8D' : '#6B7B8F',
                fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
              }}
              onClick={() => setNoteType(t.value)}
            >
              {t.icon} {t.label}
            </button>
          ))}
          <span style={{ width: 1, height: 20, background: '#D1D5DB', margin: '0 4px' }} />
          <button
            style={{
              padding: '5px 12px', borderRadius: 20, border: '1px solid',
              borderColor: showPortalOnly ? '#2E4E8D' : '#D1D5DB',
              background: showPortalOnly ? '#EBF0FA' : '#FAFBFC',
              color: showPortalOnly ? '#2E4E8D' : '#6B7B8F',
              fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
            }}
            onClick={() => setShowPortalOnly(!showPortalOnly)}
          >
            {showPortalOnly ? '✓ ' : ''}Internal Notes Only
          </button>
        </div>

        {/* Direction + Outcome row for communications */}
        {isCommunication && (
          <div style={{ display: 'flex', gap: 10, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <div style={{ display: 'flex', gap: 4 }}>
              {['outbound', 'inbound'].map((d) => (
                <button
                  key={d}
                  style={{
                    padding: '4px 10px', borderRadius: 6, border: '1px solid',
                    borderColor: noteDirection === d ? '#1084C3' : '#D1D5DB',
                    background: noteDirection === d ? '#EBF5FB' : '#FAFBFC',
                    color: noteDirection === d ? '#1084C3' : '#6B7B8F',
                    fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
                  }}
                  onClick={() => setNoteDirection(d)}
                >
                  {d === 'outbound' ? '↗ Outbound' : '↙ Inbound'}
                </button>
              ))}
            </div>
            <select
              style={{ ...styles.fieldInput, padding: '4px 8px', fontSize: 12, maxWidth: 160 }}
              value={noteOutcome}
              onChange={(e) => setNoteOutcome(e.target.value)}
            >
              <option value="">Outcome...</option>
              {NOTE_OUTCOMES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
        )}

        {/* Note text input */}
        <div style={styles.noteInputRow}>
          <input style={styles.noteInput} placeholder={isCommunication ? 'What was discussed or attempted...' : 'Add an internal note...'} value={noteText} onChange={(e) => setNoteText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleAddNote()} />
          <button className="tc-btn-primary" style={styles.primaryBtn} onClick={handleAddNote}>Add</button>
        </div>

        {/* Merged timeline */}
        {rcLoading && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', color: '#6B7B8F', fontSize: 13 }}>
            <span style={{ display: 'inline-block', width: 14, height: 14, border: '2px solid #D1D5DB', borderTopColor: '#2E4E8D', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
            Loading communication history...
          </div>
        )}
        <div style={styles.notesList}>
          {(showPortalOnly ? mergedTimeline.filter((n) => n.source !== 'ringcentral') : mergedTimeline).map((n) => {
            const typeInfo = NOTE_TYPES.find((t) => t.value === n.type);
            const outcomeInfo = NOTE_OUTCOMES.find((o) => o.value === n.outcome);
            const isRC = n.source === 'ringcentral';
            return (
              <div key={n.id} style={styles.noteItem}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 }}>
                  <div style={styles.noteTimestamp}>
                    {new Date(n.timestamp).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                    {n.author && <span style={{ marginLeft: 8, color: '#2E4E8D', fontWeight: 600 }}>— {n.author}</span>}
                    {isRC && <span style={{ marginLeft: 8, color: '#9CA3AF', fontSize: 11, fontWeight: 500 }}>(RingCentral)</span>}
                  </div>
                  {(n.type && n.type !== 'note') && (
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: '#EBF0FA', color: '#2E4E8D', fontWeight: 600 }}>
                        {typeInfo?.icon || (n.type === 'call' ? '📞' : '💬')} {typeInfo?.label || (n.type === 'call' ? 'Phone Call' : 'Text Message')}
                      </span>
                      {n.direction && (
                        <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: n.direction === 'inbound' ? '#E8F5E9' : '#FFF8ED', color: n.direction === 'inbound' ? '#388E3C' : '#D97706', fontWeight: 600 }}>
                          {n.direction === 'inbound' ? '↙ In' : '↗ Out'}
                        </span>
                      )}
                      {outcomeInfo && (
                        <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: '#F5F5F5', color: '#556270', fontWeight: 600 }}>
                          {outcomeInfo.label}
                        </span>
                      )}
                      {n.hasRecording && (
                        <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: '#E0F2FE', color: '#0284C7', fontWeight: 600 }}>
                          Recorded
                        </span>
                      )}
                    </div>
                  )}
                </div>
                <div style={styles.noteText}>{n.text}</div>
              </div>
            );
          })}
          {mergedTimeline.length === 0 && !rcLoading && !showPortalOnly && (
            <div style={{ color: '#6B7B8F', fontSize: 13, padding: 16, textAlign: 'center' }}>No activity yet. Log your outreach and communications here.</div>
          )}
          {showPortalOnly && mergedTimeline.filter((n) => n.source !== 'ringcentral').length === 0 && (
            <div style={{ color: '#6B7B8F', fontSize: 13, padding: 16, textAlign: 'center' }}>No internal notes yet.</div>
          )}
        </div>
      </div>
    </div>
  );
}
