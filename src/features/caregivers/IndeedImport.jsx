import { useState, useRef, useCallback } from 'react';
import { processIndeedCsv } from '../../lib/indeedCsvParser';
import { normalizePhone } from '../../lib/intakeProcessing';
import btn from '../../styles/buttons.module.css';
import forms from '../../styles/forms.module.css';

// ─── Dedup helper ────────────────────────────────────────────
function findDuplicates(records, existingCaregivers) {
  const existingPhones = new Set();
  const existingEmails = new Set();

  existingCaregivers.forEach((cg) => {
    if (cg.phone) existingPhones.add(normalizePhone(cg.phone));
    if (cg.email) existingEmails.add(cg.email.toLowerCase());
  });

  return records.map((r) => {
    const phone = r.caregiverData.phone;
    const email = r.caregiverData.email?.toLowerCase();
    // Skip @indeedemail.com for email dedup — those are masked/temporary
    const isIndeedEmail = email && email.endsWith('@indeedemail.com');
    const dupByPhone = phone && existingPhones.has(phone);
    const dupByEmail = !isIndeedEmail && email && existingEmails.has(email);
    return {
      ...r,
      isDuplicate: dupByPhone || dupByEmail,
      dupReason: dupByPhone ? 'Phone already exists' : dupByEmail ? 'Email already exists' : null,
    };
  });
}

// ─── Modal overlay styles ────────────────────────────────────
const overlay = {
  position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
  background: 'rgba(0,0,0,0.5)', display: 'flex',
  alignItems: 'center', justifyContent: 'center', zIndex: 9999,
};
const modal = {
  background: '#fff', borderRadius: 16, padding: 32, maxWidth: 720,
  width: '90vw', maxHeight: '85vh', overflow: 'auto',
  boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
};
const dropZone = (isDragging) => ({
  border: `2px dashed ${isDragging ? '#29BEE4' : '#D5DCE6'}`,
  borderRadius: 12, padding: 40, textAlign: 'center', cursor: 'pointer',
  background: isDragging ? '#F0FAFF' : '#FAFBFC',
  transition: 'all 0.2s',
});
const tableStyle = {
  width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 16,
};
const thStyle = {
  textAlign: 'left', padding: '8px 12px', borderBottom: '2px solid #E5E9F0',
  color: '#6B7A90', fontWeight: 600, fontSize: 11, textTransform: 'uppercase',
};
const tdStyle = {
  padding: '8px 12px', borderBottom: '1px solid #F0F2F5',
};
const badge = (color, bg) => ({
  display: 'inline-block', padding: '2px 8px', borderRadius: 6,
  fontSize: 11, fontWeight: 600, color, background: bg,
});

export function IndeedImportModal({ onClose, onImport, existingCaregivers }) {
  const [step, setStep] = useState('upload'); // upload | preview | importing | done
  const [isDragging, setIsDragging] = useState(false);
  const [records, setRecords] = useState([]);
  const [skipped, setSkipped] = useState([]);
  const [importResult, setImportResult] = useState(null);
  const fileInputRef = useRef(null);

  const handleFile = useCallback((file) => {
    if (!file || !file.name.endsWith('.csv')) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const { records: parsed, skipped: skippedRows } = processIndeedCsv(e.target.result);
      const withDupes = findDuplicates(parsed, existingCaregivers);
      setRecords(withDupes);
      setSkipped(skippedRows);
      setStep('preview');
    };
    reader.readAsText(file);
  }, [existingCaregivers]);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer?.files?.[0];
    handleFile(file);
  }, [handleFile]);

  const handleImport = useCallback(async () => {
    const toImport = records.filter((r) => !r.isDuplicate);
    if (toImport.length === 0) return;

    setStep('importing');
    const imported = [];
    const failed = [];

    for (const record of toImport) {
      try {
        onImport(record.caregiverData, record.note);
        imported.push(record);
      } catch (err) {
        failed.push({ ...record, error: err.message });
      }
    }

    setImportResult({
      imported: imported.length,
      duplicates: records.filter((r) => r.isDuplicate).length,
      failed: failed.length,
      skipped: skipped.length,
    });
    setStep('done');
  }, [records, skipped, onImport]);

  const newCount = records.filter((r) => !r.isDuplicate).length;
  const dupCount = records.filter((r) => r.isDuplicate).length;

  return (
    <div style={overlay} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={modal}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
          <div>
            <h2 style={{ margin: 0, color: '#1A2B4A', fontSize: 20 }}>Import from Indeed</h2>
            <p style={{ margin: '4px 0 0', color: '#6B7A90', fontSize: 13 }}>
              Upload a CSV exported from your Indeed employer dashboard
            </p>
          </div>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', fontSize: 24, cursor: 'pointer', color: '#6B7A90', padding: 4 }}
          >
            x
          </button>
        </div>

        {/* Step 1: Upload */}
        {step === 'upload' && (
          <div
            style={dropZone(isDragging)}
            onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv"
              style={{ display: 'none' }}
              onChange={(e) => handleFile(e.target.files?.[0])}
            />
            <div style={{ fontSize: 36, marginBottom: 8 }}>CSV</div>
            <p style={{ margin: 0, color: '#1A2B4A', fontWeight: 600 }}>
              Drop your Indeed CSV file here
            </p>
            <p style={{ margin: '8px 0 0', color: '#6B7A90', fontSize: 13 }}>
              or click to browse. Export from Indeed: Candidates tab &gt; Select all &gt; Export candidates
            </p>
          </div>
        )}

        {/* Step 2: Preview */}
        {step === 'preview' && (
          <div>
            {/* Summary */}
            <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
              <div style={{ ...badge('#1A6B35', '#E6F5EC'), padding: '6px 12px', fontSize: 13 }}>
                {newCount} new {newCount === 1 ? 'caregiver' : 'caregivers'}
              </div>
              {dupCount > 0 && (
                <div style={{ ...badge('#8B6914', '#FFF8E1'), padding: '6px 12px', fontSize: 13 }}>
                  {dupCount} {dupCount === 1 ? 'duplicate' : 'duplicates'} (will skip)
                </div>
              )}
              {skipped.length > 0 && (
                <div style={{ ...badge('#9B1C1C', '#FDE8E8'), padding: '6px 12px', fontSize: 13 }}>
                  {skipped.length} invalid (will skip)
                </div>
              )}
            </div>

            {/* Records table */}
            <div style={{ overflowX: 'auto' }}>
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={thStyle}>Name</th>
                    <th style={thStyle}>Phone</th>
                    <th style={thStyle}>Location</th>
                    <th style={thStyle}>Date</th>
                    <th style={thStyle}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {records.map((r, i) => (
                    <tr key={i} style={{ opacity: r.isDuplicate ? 0.5 : 1 }}>
                      <td style={tdStyle}>
                        <strong>{r.caregiverData.firstName} {r.caregiverData.lastName}</strong>
                      </td>
                      <td style={tdStyle}>{r.caregiverData.phone}</td>
                      <td style={tdStyle}>
                        {[r.caregiverData.city, r.caregiverData.state].filter(Boolean).join(', ')}
                      </td>
                      <td style={tdStyle}>{r.caregiverData.applicationDate}</td>
                      <td style={tdStyle}>
                        {r.isDuplicate
                          ? <span style={badge('#8B6914', '#FFF8E1')}>Duplicate</span>
                          : <span style={badge('#1A6B35', '#E6F5EC')}>New</span>
                        }
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Skipped rows */}
            {skipped.length > 0 && (
              <div style={{ marginTop: 16, padding: 12, background: '#FDE8E8', borderRadius: 8, fontSize: 13 }}>
                <strong>Skipped rows:</strong>
                {skipped.map((s, i) => (
                  <div key={i}>Row {s.row}: {s.name} — {s.reason}</div>
                ))}
              </div>
            )}

            {/* Actions */}
            <div style={{ display: 'flex', gap: 12, marginTop: 24, justifyContent: 'flex-end' }}>
              <button className={btn.secondaryBtn} onClick={() => { setStep('upload'); setRecords([]); setSkipped([]); }}>
                Back
              </button>
              <button
                className={btn.primaryBtn}
                onClick={handleImport}
                disabled={newCount === 0}
                style={newCount === 0 ? { opacity: 0.5, cursor: 'not-allowed' } : {}}
              >
                Import {newCount} {newCount === 1 ? 'Caregiver' : 'Caregivers'}
              </button>
            </div>
          </div>
        )}

        {/* Step 3: Importing */}
        {step === 'importing' && (
          <div style={{ textAlign: 'center', padding: 40 }}>
            <div style={{ fontSize: 36, marginBottom: 16 }}>...</div>
            <p style={{ color: '#1A2B4A', fontWeight: 600 }}>Importing caregivers...</p>
          </div>
        )}

        {/* Step 4: Done */}
        {step === 'done' && importResult && (
          <div style={{ textAlign: 'center', padding: 24 }}>
            <div style={{ fontSize: 36, marginBottom: 16 }}>Done</div>
            <h3 style={{ color: '#1A2B4A', margin: '0 0 16px' }}>Import Complete</h3>
            <div style={{ display: 'flex', gap: 16, justifyContent: 'center', flexWrap: 'wrap', marginBottom: 24 }}>
              {importResult.imported > 0 && (
                <div style={{ ...badge('#1A6B35', '#E6F5EC'), padding: '8px 16px', fontSize: 14 }}>
                  {importResult.imported} imported
                </div>
              )}
              {importResult.duplicates > 0 && (
                <div style={{ ...badge('#8B6914', '#FFF8E1'), padding: '8px 16px', fontSize: 14 }}>
                  {importResult.duplicates} duplicates skipped
                </div>
              )}
              {importResult.failed > 0 && (
                <div style={{ ...badge('#9B1C1C', '#FDE8E8'), padding: '8px 16px', fontSize: 14 }}>
                  {importResult.failed} failed
                </div>
              )}
            </div>
            <button className={btn.primaryBtn} onClick={onClose}>
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
