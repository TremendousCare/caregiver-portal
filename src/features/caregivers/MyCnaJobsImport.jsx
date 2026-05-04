import { useState, useRef, useCallback, useMemo } from 'react';
import { supabase } from '../../lib/supabase';
import { processExtractedResume, findDuplicates } from '../../lib/mycnaResumeParser';
import { normalizePhone } from '../../lib/intakeProcessing';
import btn from '../../styles/buttons.module.css';

// ─── File → base64 ───────────────────────────────────────────
function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('File read failed'));
    reader.onload = () => {
      const result = String(reader.result || '');
      const idx = result.indexOf(',');
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

// ─── Parallel runner with concurrency cap ────────────────────
async function runWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function take() {
    while (next < items.length) {
      const myIdx = next++;
      results[myIdx] = await worker(items[myIdx], myIdx);
    }
  }
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, () => take());
  await Promise.all(runners);
  return results;
}

// ─── Parse one PDF via edge function ─────────────────────────
async function parseOnePdf(file) {
  const pdfBase64 = await readFileAsBase64(file);
  const { data, error } = await supabase.functions.invoke('parse-resume-pdf', {
    body: { pdf_base64: pdfBase64, file_name: file.name },
  });
  if (error) {
    const detail = data?.detail || data?.error || error.message || 'Unknown error';
    throw new Error(detail);
  }
  if (!data?.extracted) {
    throw new Error(data?.error || 'No extraction returned');
  }
  return data.extracted;
}

// ─── Re-validate a record after the user edits its fields ────
function recheckDuplicate(record, existingCaregivers) {
  const existingPhones = new Set();
  const existingEmails = new Set();
  existingCaregivers.forEach((cg) => {
    if (cg.phone) existingPhones.add(normalizePhone(cg.phone));
    if (cg.email) existingEmails.add(cg.email.toLowerCase());
  });
  const phone = record.caregiverData.phone;
  const email = record.caregiverData.email?.toLowerCase();
  const dupByPhone = phone && existingPhones.has(phone);
  const dupByEmail = email && existingEmails.has(email);
  return {
    ...record,
    isDuplicate: dupByPhone || dupByEmail,
    dupReason: dupByPhone ? 'Phone already exists' : dupByEmail ? 'Email already exists' : null,
  };
}

// ─── Modal styles (match IndeedImport.jsx) ───────────────────
const overlay = {
  position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
  background: 'rgba(0,0,0,0.5)', display: 'flex',
  alignItems: 'center', justifyContent: 'center', zIndex: 9999,
};
const modal = {
  background: '#fff', borderRadius: 16, padding: 32, maxWidth: 880,
  width: '92vw', maxHeight: '85vh', overflow: 'auto',
  boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
};
const dropZone = (isDragging) => ({
  border: `2px dashed ${isDragging ? '#29BEE4' : '#D5DCE6'}`,
  borderRadius: 12, padding: 40, textAlign: 'center', cursor: 'pointer',
  background: isDragging ? '#F0FAFF' : '#FAFBFC',
  transition: 'all 0.2s',
});
const tableStyle = { width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 16 };
const thStyle = {
  textAlign: 'left', padding: '8px 12px', borderBottom: '2px solid #E5E9F0',
  color: '#6B7A90', fontWeight: 600, fontSize: 11, textTransform: 'uppercase',
};
const tdStyle = { padding: '8px 12px', borderBottom: '1px solid #F0F2F5', verticalAlign: 'top' };
const inputStyle = {
  width: '100%', padding: '4px 6px', fontSize: 13, border: '1px solid #D5DCE6',
  borderRadius: 4, background: '#fff',
};
const badge = (color, bg) => ({
  display: 'inline-block', padding: '2px 8px', borderRadius: 6,
  fontSize: 11, fontWeight: 600, color, background: bg,
});

const CONCURRENCY = 5;

export function MyCnaJobsImportModal({ onClose, onImport, existingCaregivers }) {
  const [step, setStep] = useState('upload'); // upload | parsing | preview | importing | done
  const [isDragging, setIsDragging] = useState(false);
  const [parseProgress, setParseProgress] = useState({ done: 0, total: 0 });
  const [records, setRecords] = useState([]);
  const [parseFailures, setParseFailures] = useState([]); // { fileName, error }
  const [validationSkipped, setValidationSkipped] = useState([]); // { fileName, reason }
  const [importResult, setImportResult] = useState(null);
  const fileInputRef = useRef(null);

  const handleFiles = useCallback(async (fileList) => {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList).filter((f) => f.name.toLowerCase().endsWith('.pdf'));
    if (files.length === 0) return;

    setStep('parsing');
    setParseProgress({ done: 0, total: files.length });
    setRecords([]);
    setParseFailures([]);
    setValidationSkipped([]);

    let doneCount = 0;
    const collectedRecords = [];
    const collectedFailures = [];
    const collectedSkipped = [];

    await runWithConcurrency(files, CONCURRENCY, async (file) => {
      try {
        const extracted = await parseOnePdf(file);
        const result = processExtractedResume(extracted, file.name);
        if (result.record) {
          collectedRecords.push(result.record);
        } else if (result.skipped) {
          collectedSkipped.push(result.skipped);
        }
      } catch (err) {
        collectedFailures.push({
          fileName: file.name,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        doneCount += 1;
        setParseProgress({ done: doneCount, total: files.length });
      }
    });

    const withDupes = findDuplicates(collectedRecords, existingCaregivers);
    setRecords(withDupes);
    setParseFailures(collectedFailures);
    setValidationSkipped(collectedSkipped);
    setStep('preview');
  }, [existingCaregivers]);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setIsDragging(false);
    handleFiles(e.dataTransfer?.files);
  }, [handleFiles]);

  const updateRecordField = useCallback((index, field, value) => {
    setRecords((prev) => {
      const updated = prev.map((r, i) => {
        if (i !== index) return r;
        const newCaregiverData = {
          ...r.caregiverData,
          [field]: field === 'phone' ? normalizePhone(value) : value,
        };
        return { ...r, caregiverData: newCaregiverData };
      });
      // Re-check duplicate status against the existing list — edits to
      // phone/email can flip a row in or out of the dup state.
      return updated.map((r, i) => (i === index ? recheckDuplicate(r, existingCaregivers) : r));
    });
  }, [existingCaregivers]);

  const removeRecord = useCallback((index) => {
    setRecords((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleImport = useCallback(async () => {
    const toImport = records.filter((r) => !r.isDuplicate);
    if (toImport.length === 0) return;

    setStep('importing');
    let imported = 0;
    let failed = 0;

    for (const record of toImport) {
      try {
        onImport(record.caregiverData, record.note);
        imported += 1;
      } catch {
        failed += 1;
      }
    }

    setImportResult({
      imported,
      duplicates: records.filter((r) => r.isDuplicate).length,
      failed,
      parseFailures: parseFailures.length,
      validationSkipped: validationSkipped.length,
    });
    setStep('done');
  }, [records, parseFailures, validationSkipped, onImport]);

  const newCount = useMemo(() => records.filter((r) => !r.isDuplicate).length, [records]);
  const dupCount = useMemo(() => records.filter((r) => r.isDuplicate).length, [records]);

  return (
    <div style={overlay} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={modal}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
          <div>
            <h2 style={{ margin: 0, color: '#1A2B4A', fontSize: 20 }}>Import from mycnajobs</h2>
            <p style={{ margin: '4px 0 0', color: '#6B7A90', fontSize: 13 }}>
              Drop one or more resume PDFs. Claude extracts the fields; you review before importing.
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
              accept=".pdf,application/pdf"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => handleFiles(e.target.files)}
            />
            <div style={{ fontSize: 36, marginBottom: 8 }}>PDF</div>
            <p style={{ margin: 0, color: '#1A2B4A', fontWeight: 600 }}>
              Drop one or more mycnajobs resume PDFs here
            </p>
            <p style={{ margin: '8px 0 0', color: '#6B7A90', fontSize: 13 }}>
              or click to browse. Up to ~30 at once is comfortable; more will queue automatically.
            </p>
          </div>
        )}

        {/* Step 2: Parsing */}
        {step === 'parsing' && (
          <div style={{ textAlign: 'center', padding: 40 }}>
            <div style={{ fontSize: 36, marginBottom: 16 }}>...</div>
            <p style={{ color: '#1A2B4A', fontWeight: 600, margin: 0 }}>
              Extracting resume data
            </p>
            <p style={{ color: '#6B7A90', marginTop: 8 }}>
              {parseProgress.done} of {parseProgress.total} done
            </p>
            <div style={{
              width: '60%', margin: '16px auto 0', height: 6, background: '#F0F2F5',
              borderRadius: 3, overflow: 'hidden',
            }}>
              <div style={{
                height: '100%',
                width: `${parseProgress.total ? (parseProgress.done / parseProgress.total) * 100 : 0}%`,
                background: '#29BEE4',
                transition: 'width 0.2s',
              }} />
            </div>
          </div>
        )}

        {/* Step 3: Preview */}
        {step === 'preview' && (
          <div>
            {/* Summary */}
            <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
              <div style={{ ...badge('#1A6B35', '#E6F5EC'), padding: '6px 12px', fontSize: 13 }}>
                {newCount} new {newCount === 1 ? 'caregiver' : 'caregivers'}
              </div>
              {dupCount > 0 && (
                <div style={{ ...badge('#8B6914', '#FFF8E1'), padding: '6px 12px', fontSize: 13 }}>
                  {dupCount} {dupCount === 1 ? 'duplicate' : 'duplicates'} (will skip)
                </div>
              )}
              {validationSkipped.length > 0 && (
                <div style={{ ...badge('#9B1C1C', '#FDE8E8'), padding: '6px 12px', fontSize: 13 }}>
                  {validationSkipped.length} missing required data (will skip)
                </div>
              )}
              {parseFailures.length > 0 && (
                <div style={{ ...badge('#9B1C1C', '#FDE8E8'), padding: '6px 12px', fontSize: 13 }}>
                  {parseFailures.length} {parseFailures.length === 1 ? 'PDF' : 'PDFs'} failed to parse
                </div>
              )}
            </div>

            <p style={{ margin: '0 0 8px', color: '#6B7A90', fontSize: 12 }}>
              Tip: Claude extracts ~95% accurately. Scan the rows below — click any field to edit before importing.
            </p>

            {/* Records table — editable */}
            <div style={{ overflowX: 'auto' }}>
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={thStyle}>First name</th>
                    <th style={thStyle}>Last name</th>
                    <th style={thStyle}>Phone</th>
                    <th style={thStyle}>Email</th>
                    <th style={thStyle}>City</th>
                    <th style={thStyle}>State</th>
                    <th style={thStyle}>File</th>
                    <th style={thStyle}>Status</th>
                    <th style={thStyle}></th>
                  </tr>
                </thead>
                <tbody>
                  {records.map((r, i) => (
                    <tr key={i} style={{ opacity: r.isDuplicate ? 0.55 : 1 }}>
                      <td style={tdStyle}>
                        <input
                          style={inputStyle}
                          value={r.caregiverData.firstName}
                          onChange={(e) => updateRecordField(i, 'firstName', e.target.value)}
                        />
                      </td>
                      <td style={tdStyle}>
                        <input
                          style={inputStyle}
                          value={r.caregiverData.lastName}
                          onChange={(e) => updateRecordField(i, 'lastName', e.target.value)}
                        />
                      </td>
                      <td style={tdStyle}>
                        <input
                          style={inputStyle}
                          value={r.caregiverData.phone}
                          onChange={(e) => updateRecordField(i, 'phone', e.target.value)}
                          placeholder="10-digit"
                        />
                      </td>
                      <td style={tdStyle}>
                        <input
                          style={inputStyle}
                          value={r.caregiverData.email}
                          onChange={(e) => updateRecordField(i, 'email', e.target.value)}
                        />
                      </td>
                      <td style={tdStyle}>
                        <input
                          style={inputStyle}
                          value={r.caregiverData.city}
                          onChange={(e) => updateRecordField(i, 'city', e.target.value)}
                        />
                      </td>
                      <td style={tdStyle}>
                        <input
                          style={{ ...inputStyle, width: 56 }}
                          value={r.caregiverData.state}
                          onChange={(e) => updateRecordField(i, 'state', e.target.value)}
                          maxLength={2}
                        />
                      </td>
                      <td style={{ ...tdStyle, color: '#6B7A90', fontSize: 11, maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.fileName}>
                        {r.fileName}
                      </td>
                      <td style={tdStyle}>
                        {r.isDuplicate
                          ? <span style={badge('#8B6914', '#FFF8E1')} title={r.dupReason}>Duplicate</span>
                          : <span style={badge('#1A6B35', '#E6F5EC')}>New</span>
                        }
                      </td>
                      <td style={tdStyle}>
                        <button
                          onClick={() => removeRecord(i)}
                          style={{ background: 'none', border: 'none', color: '#9B1C1C', cursor: 'pointer', fontSize: 12 }}
                          title="Remove from import"
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Skipped + failed details */}
            {(validationSkipped.length > 0 || parseFailures.length > 0) && (
              <div style={{ marginTop: 16, padding: 12, background: '#FDE8E8', borderRadius: 8, fontSize: 12 }}>
                {validationSkipped.length > 0 && (
                  <div>
                    <strong>Missing required data:</strong>
                    {validationSkipped.map((s, i) => (
                      <div key={i}>{s.fileName} — {s.reason}</div>
                    ))}
                  </div>
                )}
                {parseFailures.length > 0 && (
                  <div style={{ marginTop: validationSkipped.length > 0 ? 8 : 0 }}>
                    <strong>Failed to parse:</strong>
                    {parseFailures.map((f, i) => (
                      <div key={i}>{f.fileName} — {f.error}</div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Actions */}
            <div style={{ display: 'flex', gap: 12, marginTop: 24, justifyContent: 'flex-end' }}>
              <button
                className={btn.secondaryBtn}
                onClick={() => {
                  setStep('upload');
                  setRecords([]);
                  setParseFailures([]);
                  setValidationSkipped([]);
                }}
              >
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

        {/* Step 4: Importing */}
        {step === 'importing' && (
          <div style={{ textAlign: 'center', padding: 40 }}>
            <div style={{ fontSize: 36, marginBottom: 16 }}>...</div>
            <p style={{ color: '#1A2B4A', fontWeight: 600 }}>Importing caregivers...</p>
          </div>
        )}

        {/* Step 5: Done */}
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
              {importResult.parseFailures > 0 && (
                <div style={{ ...badge('#9B1C1C', '#FDE8E8'), padding: '8px 16px', fontSize: 14 }}>
                  {importResult.parseFailures} parse failures
                </div>
              )}
              {importResult.failed > 0 && (
                <div style={{ ...badge('#9B1C1C', '#FDE8E8'), padding: '8px 16px', fontSize: 14 }}>
                  {importResult.failed} import failures
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
