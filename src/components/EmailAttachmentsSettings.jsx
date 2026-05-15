// Email Attachment Library — admin UI for uploading and managing PDFs
// (and other files) that automation rules can attach to outbound emails.
//
// Flow:
//   1. Admin uploads file via this UI → file lands in `email-attachments`
//      Storage bucket; metadata row inserted in `email_attachment_files`.
//   2. Admin builds an automation rule and picks files from the library;
//      file UUIDs are stored on `automation_rules.action_config.attachment_file_ids`.
//   3. When the rule fires, `outlook-integration` downloads the bytes
//      and attaches them via the Microsoft Graph upload-session flow.
//
// Files are scoped to org via storage path prefix and `email_attachment_files.org_id`.
// The Storage RLS policies (migration 20260515000000) gate writes on `is_admin()`.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Trash2, Upload, FileText, AlertTriangle } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { CollapsibleCard } from '../shared/components/CollapsibleCard';
import btn from '../styles/buttons.module.css';
import cards from '../styles/cards.module.css';

const BUCKET = 'email-attachments';
// Mirror the per-file cap in supabase/functions/outlook-integration/index.ts
// (`MAX_ATTACHMENT_BYTES_PER_FILE`). Keep the two in sync — exceeding the
// edge-function cap would let an admin upload a file that fails at send time.
const MAX_FILE_BYTES = 20 * 1024 * 1024;

function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function getOrgIdFromJwt() {
  try {
    // We can't synchronously read the JWT, so this is only used by the
    // initial upload path which is admin-only. The upload still works
    // even if we can't extract org_id here (path falls back to "shared/")
    // — RLS gates the actual write, not this prefix.
    const raw = localStorage.getItem('sb-zocrnurvazyxdpyqimgj-auth-token');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const token = parsed?.access_token;
    if (!token) return null;
    const payload = token.split('.')[1];
    if (!payload) return null;
    const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    return json?.org_id || null;
  } catch {
    return null;
  }
}

export function EmailAttachmentsSettings({ showToast, currentUserEmail }) {
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const [usageById, setUsageById] = useState({});
  const fileInputRef = useRef(null);

  const loadFiles = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('email_attachment_files')
        .select('id, file_name, content_type, size_bytes, description, created_at, created_by')
        .order('file_name', { ascending: true });
      if (error) throw error;
      setFiles(data || []);

      // Count how many automation rules reference each file so admins
      // see "used by 1 rule" before they delete. Pull rules with any
      // attachment_file_ids and tally client-side — there shouldn't be
      // enough of them to justify a server-side aggregation.
      const { data: rules } = await supabase
        .from('automation_rules')
        .select('id, name, action_config')
        .eq('action_type', 'send_email');
      const usage = {};
      (rules || []).forEach((r) => {
        const ids = r?.action_config?.attachment_file_ids;
        if (!Array.isArray(ids)) return;
        ids.forEach((id) => {
          if (!usage[id]) usage[id] = [];
          usage[id].push(r.name || r.id);
        });
      });
      setUsageById(usage);
    } catch (err) {
      console.error('Failed to load email attachment files:', err);
      showToast?.('Failed to load email attachments. Check console.');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => { loadFiles(); }, [loadFiles]);

  const handleUploadClick = () => fileInputRef.current?.click();

  const handleFileSelected = useCallback(async (e) => {
    const fileList = Array.from(e.target.files || []);
    if (fileList.length === 0) return;

    // Validate first so we don't half-succeed on a batch.
    for (const f of fileList) {
      if (f.size > MAX_FILE_BYTES) {
        showToast?.(`"${f.name}" is ${formatBytes(f.size)} — exceeds ${formatBytes(MAX_FILE_BYTES)} per-file cap.`);
        e.target.value = '';
        return;
      }
    }

    setUploading(true);
    const orgId = getOrgIdFromJwt();
    const prefix = orgId || 'shared';
    try {
      for (const file of fileList) {
        // Random suffix keeps re-uploads of the same filename from
        // colliding. We could SHA the bytes for content-addressing but
        // that adds complexity for a settings flow used by one admin
        // every few months.
        const ext = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.')) : '';
        const objectName = `${prefix}/${crypto.randomUUID()}${ext}`;

        const { error: uploadErr } = await supabase.storage
          .from(BUCKET)
          .upload(objectName, file, {
            contentType: file.type || 'application/octet-stream',
            upsert: false,
          });
        if (uploadErr) throw uploadErr;

        const { error: insertErr } = await supabase
          .from('email_attachment_files')
          .insert({
            org_id: orgId || null,
            file_name: file.name,
            storage_path: objectName,
            content_type: file.type || 'application/octet-stream',
            size_bytes: file.size,
            created_by: currentUserEmail || null,
          });
        if (insertErr) {
          // Roll back the storage object so we don't leave an orphan
          // blob if the metadata row fails (e.g. RLS denies the insert).
          await supabase.storage.from(BUCKET).remove([objectName]).catch(() => {});
          throw insertErr;
        }
      }
      showToast?.(`Uploaded ${fileList.length} file${fileList.length === 1 ? '' : 's'}.`);
      await loadFiles();
    } catch (err) {
      console.error('Upload failed:', err);
      showToast?.(`Upload failed: ${err.message}`);
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  }, [currentUserEmail, loadFiles, showToast]);

  const handleDelete = useCallback(async (file) => {
    const inUse = usageById[file.id] || [];
    const warning = inUse.length > 0
      ? `\n\nWARNING: This file is attached to ${inUse.length} automation rule${inUse.length === 1 ? '' : 's'}:\n${inUse.slice(0, 5).map((n) => `  • ${n}`).join('\n')}${inUse.length > 5 ? `\n  • …and ${inUse.length - 5} more` : ''}\n\nDeleting will cause those rules to fail the next time they fire.`
      : '';
    if (!window.confirm(`Delete "${file.file_name}"?${warning}\n\nThis cannot be undone.`)) return;

    setDeletingId(file.id);
    try {
      // Delete the metadata row first; if storage removal fails after
      // that we'll leak a blob, but the rule won't pick a broken row
      // (which is the worse failure mode).
      const { error: delErr } = await supabase
        .from('email_attachment_files')
        .delete()
        .eq('id', file.id);
      if (delErr) throw delErr;

      const { error: storageErr } = await supabase.storage
        .from(BUCKET)
        .remove([file.storage_path]);
      if (storageErr) {
        console.warn(`Metadata deleted but storage object lingers for ${file.file_name}:`, storageErr);
      }

      showToast?.(`Deleted "${file.file_name}".`);
      await loadFiles();
    } catch (err) {
      console.error('Delete failed:', err);
      showToast?.(`Delete failed: ${err.message}`);
    } finally {
      setDeletingId(null);
    }
  }, [loadFiles, showToast, usageById]);

  const renderBody = () => {
    if (loading) {
      return <div style={{ color: '#7A8BA0', fontSize: 13 }}>Loading...</div>;
    }
    return (
      <>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#7A8BA0', textTransform: 'uppercase', letterSpacing: 1 }}>
            Files ({files.length})
          </div>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={handleFileSelected}
            style={{ display: 'none' }}
            accept="application/pdf,image/*,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          />
          <button
            className={btn.primaryBtn}
            style={{ padding: '6px 12px', fontSize: 12, opacity: uploading ? 0.6 : 1, display: 'inline-flex', alignItems: 'center', gap: 6 }}
            onClick={handleUploadClick}
            disabled={uploading}
          >
            <Upload size={14} />
            {uploading ? 'Uploading…' : 'Upload File(s)'}
          </button>
        </div>

        {files.length === 0 ? (
          <div style={{
            padding: '24px 16px', background: '#F8F9FB', borderRadius: 10,
            border: '1px dashed #D5DCE6', color: '#7A8BA0', fontSize: 13, textAlign: 'center',
          }}>
            No files uploaded yet. Click <strong>Upload File(s)</strong> to add a PDF or document that automation rules can attach to outbound emails.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {files.map((f) => {
              const inUse = usageById[f.id] || [];
              return (
                <div
                  key={f.id}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 12,
                    padding: '10px 12px', background: '#fff',
                    border: '1px solid #E0E4EA', borderRadius: 8,
                  }}
                >
                  <FileText size={20} color="#7A8BA0" />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#0F1724', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {f.file_name}
                    </div>
                    <div style={{ fontSize: 11, color: '#7A8BA0', marginTop: 2, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                      <span>{formatBytes(f.size_bytes)}</span>
                      {f.created_at && <span>Added {new Date(f.created_at).toLocaleDateString()}</span>}
                      {inUse.length > 0 && (
                        <span style={{ color: '#15803D', fontWeight: 600 }}>
                          Used by {inUse.length} rule{inUse.length === 1 ? '' : 's'}
                        </span>
                      )}
                    </div>
                  </div>
                  <button
                    className={btn.editBtn}
                    style={{
                      padding: '4px 8px', fontSize: 11, color: '#DC2626',
                      borderColor: '#FCA5A5', display: 'inline-flex', alignItems: 'center', gap: 4,
                      opacity: deletingId === f.id ? 0.5 : 1,
                    }}
                    onClick={() => handleDelete(f)}
                    disabled={deletingId === f.id}
                    title="Delete file"
                  >
                    <Trash2 size={12} />
                    {deletingId === f.id ? 'Deleting…' : 'Delete'}
                  </button>
                </div>
              );
            })}
          </div>
        )}

        <div style={{
          marginTop: 16, padding: '10px 12px', background: '#FFFBEB',
          border: '1px solid #FDE68A', borderRadius: 8, fontSize: 12, color: '#92400E',
          display: 'flex', gap: 8,
        }}>
          <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
          <div>
            <strong>Limits:</strong> {formatBytes(MAX_FILE_BYTES)} per file, {formatBytes(MAX_FILE_BYTES)} total per email.
            Files attach to outbound emails sent by automation rules — pick which files in the rule editor under
            <em> Settings → Automations → Caregivers</em>.
          </div>
        </div>
      </>
    );
  };

  return (
    <CollapsibleCard title="Email Attachment Library" description="Files for Automation Emails">
      <div className={cards.profileCard} style={{ padding: '20px 24px', boxShadow: 'none', border: 'none' }}>
        {renderBody()}
      </div>
    </CollapsibleCard>
  );
}
