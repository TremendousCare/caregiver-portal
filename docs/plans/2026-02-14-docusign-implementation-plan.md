# DocuSign Integration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add DocuSign e-signature integration — send onboarding documents for signature, receive signed docs back via webhook, auto-upload to SharePoint, auto-complete tasks, and fire automation triggers.

**Architecture:** Single Edge Function (`docusign-integration`) handles all DocuSign API calls and webhook processing. Frontend adds a collapsible DocuSign section in the Documents tab and template configuration in Admin Settings. Automation engine gets a new `document_signed` trigger and `send_docusign_envelope` action.

**Tech Stack:** Supabase Edge Functions (Deno), DocuSign eSignature REST API, JWT Grant auth, React (JSX), CSS Modules

**Design Doc:** `docs/plans/2026-02-14-docusign-integration-design.md`

---

## Task 1: Database Migration — `docusign_envelopes` Table

**Files:**
- Migration applied via Supabase MCP tool

**Step 1: Apply the migration**

Run this migration via Supabase MCP `apply_migration` (project_id: `zocrnurvazyxdpyqimgj`):

```sql
-- Create docusign_envelopes table
CREATE TABLE IF NOT EXISTS docusign_envelopes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  envelope_id text UNIQUE NOT NULL,
  caregiver_id uuid NOT NULL REFERENCES caregivers(id),
  template_ids jsonb DEFAULT '[]'::jsonb,
  template_names jsonb DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'sent',
  sent_by text,
  sent_at timestamptz DEFAULT now(),
  completed_at timestamptz,
  status_updated_at timestamptz DEFAULT now(),
  documents_uploaded boolean DEFAULT false,
  tasks_completed jsonb DEFAULT '[]'::jsonb,
  error_detail text
);

-- Indexes
CREATE INDEX idx_docusign_envelopes_caregiver ON docusign_envelopes(caregiver_id);
CREATE INDEX idx_docusign_envelopes_status_updated ON docusign_envelopes(status_updated_at DESC);

-- RLS
ALTER TABLE docusign_envelopes ENABLE ROW LEVEL SECURITY;

-- All authenticated users can read
CREATE POLICY "Authenticated users can read docusign_envelopes"
  ON docusign_envelopes FOR SELECT
  TO authenticated
  USING (true);

-- Authenticated users can insert (sending envelopes)
CREATE POLICY "Authenticated users can insert docusign_envelopes"
  ON docusign_envelopes FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- Authenticated users can update (for status changes from webhook relay)
CREATE POLICY "Authenticated users can update docusign_envelopes"
  ON docusign_envelopes FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- Service role can do everything (for webhook Edge Function)
CREATE POLICY "Service role full access to docusign_envelopes"
  ON docusign_envelopes FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
```

**Step 2: Verify table was created**

Run via Supabase MCP `execute_sql`:
```sql
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'docusign_envelopes' ORDER BY ordinal_position;
```

Expected: 13 columns returned matching the schema above.

**Step 3: Commit**

Nothing to commit for this task — migration is applied via Supabase, not in git.

---

## Task 2: Add Constants

**Files:**
- Modify: `src/lib/constants.js`

**Step 1: Add DocuSign status constants to constants.js**

Add at the bottom of `src/lib/constants.js`:

```javascript
// ─── DocuSign Envelope Statuses ─────────────────────────────
export const DOCUSIGN_STATUSES = {
  sent: { label: 'Sent', color: '#6B7280', bg: '#F3F4F6', border: '#D1D5DB' },
  delivered: { label: 'Delivered', color: '#1D4ED8', bg: '#EFF6FF', border: '#BFDBFE' },
  viewed: { label: 'Viewed', color: '#A16207', bg: '#FFFBEB', border: '#FDE68A' },
  completed: { label: 'Completed', color: '#15803D', bg: '#F0FDF4', border: '#BBF7D0' },
  declined: { label: 'Declined', color: '#DC2626', bg: '#FEF2F2', border: '#FECACA' },
  voided: { label: 'Voided', color: '#DC2626', bg: '#FEF2F2', border: '#FECACA' },
};
```

**Step 2: Commit**

```bash
git add src/lib/constants.js
git commit -m "feat: add DocuSign envelope status constants"
```

---

## Task 3: Deploy `docusign-integration` Edge Function

**Files:**
- Deploy via Supabase MCP `deploy_edge_function`

**Step 1: Deploy the Edge Function**

Deploy via Supabase MCP `deploy_edge_function` (project_id: `zocrnurvazyxdpyqimgj`, name: `docusign-integration`, verify_jwt: `false`).

The function must handle these actions: `send_envelope`, `send_packet`, `get_envelope_status`, `list_envelopes`, `download_document`, `webhook`, `test_connection`.

Key implementation details:

**Auth pattern (JWT Grant):**
- Use `jose` library (available in Deno) to create JWT assertion
- Exchange JWT for access token at `https://account-d.docusign.com/oauth/token` (sandbox) or `https://account.docusign.com/oauth/token` (production)
- Read `docusign_environment` from `app_settings` to determine base URLs
- Cache token for ~50 minutes (tokens last 1 hour)

**Environment URLs:**
- Sandbox auth: `https://account-d.docusign.com`
- Sandbox API: `https://demo.docusign.net/restapi`
- Production auth: `https://account.docusign.com`
- Production API: `https://na1.docusign.net/restapi` (or region-specific)

**Action routing pattern** (same as outlook-integration):
```typescript
const { action, ...params } = await req.json();
switch (action) {
  case 'send_envelope': return handleSendEnvelope(params, supabaseClient);
  case 'send_packet': return handleSendPacket(params, supabaseClient);
  case 'get_envelope_status': return handleGetStatus(params);
  case 'list_envelopes': return handleListEnvelopes(params, supabaseClient);
  case 'download_document': return handleDownloadDocument(params);
  case 'webhook': return handleWebhook(req);
  case 'test_connection': return handleTestConnection();
}
```

**send_envelope action:**
- Takes: `caregiver_id`, `caregiver_email`, `caregiver_name`, `template_ids`, `template_names`, `sent_by`
- Creates a composite envelope using the DocuSign Envelopes API with `compositeTemplates`
- Each template gets the caregiver as a signer (role: `Signer`, email + name)
- Sets `status: "sent"` to send immediately
- Inserts row into `docusign_envelopes` table
- Returns: `{ success: true, envelope_id }`

**send_packet action:**
- Reads all templates from `docusign_templates` in `app_settings`
- Calls the same envelope creation logic as `send_envelope` with all template IDs

**webhook action:**
- Verify HMAC-SHA256 signature from `X-DocuSign-Signature-1` header using `DOCUSIGN_HMAC_SECRET`
- Parse XML body (DocuSign Connect sends XML by default)
- Extract `EnvelopeStatus`, `EnvelopeID`
- Update `docusign_envelopes` row: status, status_updated_at, completed_at (if completed)
- If completed:
  - Download signed documents via `GET /envelopes/{envelopeId}/documents/combined`
  - Upload to SharePoint by calling `sharepoint-docs` Edge Function internally
  - Look up linked tasks from `docusign_templates` app_setting, mark them complete in caregiver's tasks
  - Fire `document_signed` automation trigger via `execute-automation`
- Return 200 OK

**test_connection action:**
- Attempts to get an access token
- If successful, returns `{ connected: true, account_id }`
- If failed, returns `{ connected: false, error: message }`

**Secrets required** (set via Supabase dashboard or CLI):
- `DOCUSIGN_INTEGRATION_KEY`
- `DOCUSIGN_USER_ID`
- `DOCUSIGN_RSA_PRIVATE_KEY`
- `DOCUSIGN_ACCOUNT_ID`
- `DOCUSIGN_HMAC_SECRET`

**Step 2: Test the function**

Call via Supabase MCP `execute_sql` or directly:
```
POST to docusign-integration with body: { "action": "test_connection" }
```

Expected: `{ connected: true }` if secrets are configured, or `{ connected: false, error: "..." }` with a clear error message.

**Step 3: No git commit** — Edge Functions are deployed via Supabase, not in git repo.

---

## Task 4: Create DocuSignSection Component

**Files:**
- Create: `src/components/caregiver/DocuSignSection.jsx`
- Create: `src/components/caregiver/DocuSignSection.module.css`

**Step 1: Create the CSS module**

Create `src/components/caregiver/DocuSignSection.module.css`:

```css
/* DocuSign eSignatures Section */

.section {
  border-top: 1px solid #EDF0F4;
  margin-top: 8px;
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  cursor: pointer;
  user-select: none;
}

.header:hover {
  background: #FAFBFC;
}

.headerTitle {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 700;
  color: #0F1724;
  font-family: var(--tc-font-heading);
}

.arrow {
  display: inline-block;
  transition: transform 0.2s;
  font-size: 11px;
  color: #7A8BA0;
}

.arrowExpanded {
  transform: rotate(90deg);
}

.actions {
  display: flex;
  gap: 8px;
  padding: 0 20px 16px;
}

.sendBtn {
  padding: 8px 16px;
  border-radius: 10px;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  font-family: inherit;
  transition: all 0.2s;
}

.sendPacketBtn {
  composes: sendBtn;
  background: linear-gradient(135deg, var(--tc-navy), var(--tc-cyan-dark));
  color: #fff;
  border: none;
  box-shadow: 0 2px 8px rgba(46,78,141,0.25);
}

.sendPacketBtn:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(46,78,141,0.35);
}

.sendPacketBtn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
  transform: none;
}

.sendIndividualBtn {
  composes: sendBtn;
  background: #fff;
  color: var(--tc-navy);
  border: 1px solid #D5DCE6;
}

.sendIndividualBtn:hover {
  background: var(--tc-bg-hover);
  border-color: var(--tc-cyan);
}

.dropdown {
  position: relative;
  display: inline-block;
}

.dropdownMenu {
  position: absolute;
  top: 100%;
  left: 0;
  margin-top: 4px;
  background: #fff;
  border: 1px solid #E0E4EA;
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.12);
  min-width: 240px;
  z-index: 50;
  overflow: hidden;
}

.dropdownItem {
  display: block;
  width: 100%;
  padding: 10px 16px;
  border: none;
  background: none;
  text-align: left;
  font-size: 13px;
  font-weight: 500;
  color: #0F1724;
  cursor: pointer;
  font-family: inherit;
}

.dropdownItem:hover {
  background: #F0F4FA;
}

.envelopeList {
  padding: 0 20px 16px;
}

.envelopeItem {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 0;
  border-bottom: 1px solid #F0F0F0;
  gap: 12px;
}

.envelopeItem:last-child {
  border-bottom: none;
}

.envelopeInfo {
  flex: 1;
  min-width: 0;
}

.envelopeName {
  font-size: 13px;
  font-weight: 600;
  color: #1A1A1A;
}

.envelopeMeta {
  font-size: 12px;
  color: #6B7B8F;
  margin-top: 2px;
}

.statusBadge {
  display: inline-block;
  padding: 3px 10px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 700;
  flex-shrink: 0;
}

.resendBtn {
  padding: 4px 10px;
  border-radius: 6px;
  border: 1px solid #D1D5DB;
  background: #FAFBFC;
  color: var(--tc-navy);
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
  flex-shrink: 0;
}

.resendBtn:hover {
  background: var(--tc-bg-hover);
  border-color: var(--tc-cyan);
}

.emptyState {
  text-align: center;
  padding: 24px 16px;
  color: #7A8BA0;
  font-size: 13px;
}

.settingsLink {
  color: var(--tc-navy);
  text-decoration: underline;
  cursor: pointer;
  font-weight: 600;
}

.confirmOverlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.3);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}

.confirmCard {
  background: #fff;
  border-radius: 16px;
  padding: 24px;
  max-width: 420px;
  width: 90%;
  box-shadow: 0 20px 60px rgba(0,0,0,0.15);
}

.confirmTitle {
  font-size: 16px;
  font-weight: 700;
  color: #0F1724;
  margin: 0 0 8px;
}

.confirmText {
  font-size: 13px;
  color: #6B7B8F;
  margin-bottom: 20px;
  line-height: 1.5;
}

.confirmActions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}

.spinner {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 2px solid #D1D5DB;
  border-top-color: var(--tc-navy);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
```

**Step 2: Create the DocuSignSection component**

Create `src/components/caregiver/DocuSignSection.jsx`:

```jsx
import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../../lib/supabase';
import { DOCUSIGN_STATUSES } from '../../lib/constants';
import { fireEventTriggers } from '../../lib/automations';
import btn from '../../styles/buttons.module.css';
import s from './DocuSignSection.module.css';

export function DocuSignSection({ caregiver, currentUser, showToast }) {
  const [envelopes, setEnvelopes] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [expanded, setExpanded] = useState(() => localStorage.getItem('tc_docusign_expanded') === 'true');
  const [showDropdown, setShowDropdown] = useState(false);
  const [confirmSend, setConfirmSend] = useState(null); // { type: 'packet' | 'individual', templateId?, templateName? }
  const dropdownRef = useRef(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClick = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  // Fetch envelopes for this caregiver
  const fetchEnvelopes = useCallback(async () => {
    if (!caregiver?.id || !supabase) return;
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('docusign_envelopes')
        .select('*')
        .eq('caregiver_id', caregiver.id)
        .order('sent_at', { ascending: false });
      if (!error && data) setEnvelopes(data);
    } catch (err) {
      console.warn('DocuSign envelopes fetch error:', err);
    } finally {
      setLoading(false);
    }
  }, [caregiver?.id]);

  // Fetch configured templates from app_settings
  const fetchTemplates = useCallback(async () => {
    if (!supabase) return;
    try {
      const { data } = await supabase
        .from('app_settings')
        .select('value')
        .eq('key', 'docusign_templates')
        .single();
      if (data?.value && Array.isArray(data.value)) {
        setTemplates(data.value);
      }
    } catch (err) {
      console.warn('DocuSign templates fetch error:', err);
    }
  }, []);

  useEffect(() => { fetchEnvelopes(); fetchTemplates(); }, [fetchEnvelopes, fetchTemplates]);

  // Send envelope
  const handleSend = useCallback(async (templateIds, templateNames, isPacket) => {
    if (!caregiver?.email) {
      showToast?.('Caregiver has no email address configured.');
      return;
    }
    setSending(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');

      const body = {
        action: isPacket ? 'send_packet' : 'send_envelope',
        caregiver_id: caregiver.id,
        caregiver_email: caregiver.email,
        caregiver_name: `${caregiver.firstName || ''} ${caregiver.lastName || ''}`.trim(),
        sent_by: currentUser?.email || '',
      };

      if (!isPacket) {
        body.template_ids = templateIds;
        body.template_names = templateNames;
      }

      const { data, error } = await supabase.functions.invoke('docusign-integration', {
        body,
        headers: { Authorization: `Bearer ${session.access_token}` },
      });

      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      showToast?.(`DocuSign envelope sent to ${caregiver.email}`);
      await fetchEnvelopes();
    } catch (err) {
      console.error('DocuSign send failed:', err);
      showToast?.(`Failed to send: ${err.message || 'Unknown error'}`);
    } finally {
      setSending(false);
      setConfirmSend(null);
    }
  }, [caregiver, currentUser, showToast, fetchEnvelopes]);

  // Confirmation handlers
  const requestSendPacket = () => {
    setConfirmSend({ type: 'packet' });
    setShowDropdown(false);
  };

  const requestSendIndividual = (template) => {
    setConfirmSend({ type: 'individual', templateId: template.templateId, templateName: template.name });
    setShowDropdown(false);
  };

  const confirmAndSend = () => {
    if (confirmSend.type === 'packet') {
      const ids = templates.map(t => t.templateId);
      const names = templates.map(t => t.name);
      handleSend(ids, names, true);
    } else {
      handleSend([confirmSend.templateId], [confirmSend.templateName], false);
    }
  };

  // Resend a declined/voided envelope
  const handleResend = (envelope) => {
    setConfirmSend({
      type: envelope.template_ids?.length === templates.length ? 'packet' : 'individual',
      templateId: envelope.template_ids?.[0],
      templateName: envelope.template_names?.[0] || 'Document',
    });
  };

  const toggleExpanded = () => {
    const next = !expanded;
    setExpanded(next);
    localStorage.setItem('tc_docusign_expanded', String(next));
  };

  const formatDate = (dateStr) => {
    if (!dateStr) return '';
    return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  const noTemplates = templates.length === 0;

  return (
    <div className={s.section}>
      {/* Header */}
      <div className={s.header} onClick={toggleExpanded}>
        <div className={s.headerTitle}>
          <span className={`${s.arrow} ${expanded ? s.arrowExpanded : ''}`}>▶</span>
          DocuSign eSignatures
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {loading && <span className={s.spinner} />}
          {envelopes.length > 0 && (
            <span style={{
              padding: '4px 10px', borderRadius: 10, fontSize: 12, fontWeight: 600,
              background: envelopes.every(e => e.status === 'completed') ? '#DCFCE7' : '#FEF9C3',
              color: envelopes.every(e => e.status === 'completed') ? '#166534' : '#854D0E',
            }}>
              {envelopes.filter(e => e.status === 'completed').length} of {envelopes.length} signed
            </span>
          )}
        </div>
      </div>

      {expanded && (
        <>
          {/* Send Actions */}
          {!noTemplates ? (
            <div className={s.actions}>
              <button
                className={s.sendPacketBtn}
                onClick={requestSendPacket}
                disabled={sending || noTemplates}
              >
                {sending ? 'Sending...' : 'Send Full Packet'}
              </button>

              <div className={s.dropdown} ref={dropdownRef}>
                <button
                  className={s.sendIndividualBtn}
                  onClick={() => setShowDropdown(!showDropdown)}
                  disabled={sending}
                >
                  Send Individual ▾
                </button>
                {showDropdown && (
                  <div className={s.dropdownMenu}>
                    {templates.map((t) => (
                      <button
                        key={t.id || t.templateId}
                        className={s.dropdownItem}
                        onClick={() => requestSendIndividual(t)}
                      >
                        {t.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className={s.emptyState}>
              No DocuSign templates configured.{' '}
              <span className={s.settingsLink} onClick={() => {/* navigate to settings handled by parent */}}>
                Configure in Settings
              </span>
            </div>
          )}

          {/* Envelope List */}
          {envelopes.length > 0 && (
            <div className={s.envelopeList}>
              {envelopes.map((env) => {
                const statusConfig = DOCUSIGN_STATUSES[env.status] || DOCUSIGN_STATUSES.sent;
                const canResend = ['declined', 'voided'].includes(env.status);
                const displayName = env.template_names?.length > 1
                  ? `Full Onboarding Packet (${env.template_names.length} docs)`
                  : env.template_names?.[0] || 'DocuSign Envelope';
                return (
                  <div key={env.id} className={s.envelopeItem}>
                    <div className={s.envelopeInfo}>
                      <div className={s.envelopeName}>{displayName}</div>
                      <div className={s.envelopeMeta}>
                        Sent {formatDate(env.sent_at)}
                        {env.completed_at && ` · Signed ${formatDate(env.completed_at)}`}
                        {env.status === 'delivered' && ' · Awaiting signature'}
                        {env.status === 'viewed' && ' · Opened by signer'}
                        {env.sent_by && ` · by ${env.sent_by.split('@')[0]}`}
                      </div>
                    </div>
                    <span
                      className={s.statusBadge}
                      style={{
                        background: statusConfig.bg,
                        color: statusConfig.color,
                        border: `1px solid ${statusConfig.border}`,
                      }}
                    >
                      {statusConfig.label}
                    </span>
                    {canResend && (
                      <button className={s.resendBtn} onClick={() => handleResend(env)}>
                        Resend
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Empty state for envelopes */}
          {envelopes.length === 0 && templates.length > 0 && (
            <div className={s.emptyState}>
              No envelopes sent yet. Use the buttons above to send documents for signature.
            </div>
          )}
        </>
      )}

      {/* Confirmation Modal */}
      {confirmSend && (
        <div className={s.confirmOverlay} onClick={(e) => { if (e.target === e.currentTarget) setConfirmSend(null); }}>
          <div className={s.confirmCard}>
            <div className={s.confirmTitle}>Send DocuSign Envelope</div>
            <div className={s.confirmText}>
              {confirmSend.type === 'packet'
                ? `Send the full onboarding packet (${templates.length} documents) to ${caregiver?.email}?`
                : `Send "${confirmSend.templateName}" to ${caregiver?.email}?`
              }
            </div>
            <div className={s.confirmActions}>
              <button
                className={btn.secondaryBtn}
                style={{ padding: '9px 20px', fontSize: 13 }}
                onClick={() => setConfirmSend(null)}
                disabled={sending}
              >
                Cancel
              </button>
              <button
                className={btn.primaryBtn}
                style={{ padding: '9px 20px', fontSize: 13, opacity: sending ? 0.6 : 1 }}
                onClick={confirmAndSend}
                disabled={sending}
              >
                {sending ? 'Sending...' : 'Send'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
```

**Step 3: Commit**

```bash
git add src/components/caregiver/DocuSignSection.jsx src/components/caregiver/DocuSignSection.module.css
git commit -m "feat: add DocuSignSection component with send and status UI"
```

---

## Task 5: Integrate DocuSignSection into DocumentsSection

**Files:**
- Modify: `src/components/caregiver/DocumentsSection.jsx`

**Step 1: Import and render DocuSignSection**

At the top of `DocumentsSection.jsx`, add import:
```javascript
import { DocuSignSection } from './DocuSignSection';
```

Inside the `return` JSX, just before the closing `</div>` of the profileCard (after the `docsExpanded` content), add:

```jsx
{/* DocuSign eSignatures Section */}
<DocuSignSection
  caregiver={caregiver}
  currentUser={currentUser}
  showToast={showToast}
/>
```

This should go right before the final `</div>` that closes the `profileCard`.

**Step 2: Verify it renders**

Run `npm run dev` and navigate to a caregiver. The Documents section should now have a collapsible "DocuSign eSignatures" sub-section at the bottom.

**Step 3: Commit**

```bash
git add src/components/caregiver/DocumentsSection.jsx
git commit -m "feat: render DocuSignSection inside Documents tab"
```

---

## Task 6: Add DocuSign Admin Settings

**Files:**
- Modify: `src/components/AdminSettings.jsx`

**Step 1: Add DocuSign template editor and settings**

This is the most complex frontend piece. Add a new `DocuSignSettings` component inside `AdminSettings.jsx` and render it in the main `AdminSettings` function.

Add a new internal component `DocuSignSettings` that:
- Loads `docusign_templates` from `app_settings` (jsonb array)
- Displays a list of configured templates, each with: name, templateId, taskName (linked task)
- Add/edit/remove templates
- Save button upserts to `app_settings`
- Uses the existing `SettingsCard`, `EditableSetting` (for `docusign_environment`), and `IntegrationInfoCard` patterns
- Connection test button calls `docusign-integration` Edge Function with `action: 'test_connection'`

For the "Linked Task" dropdown, import `PHASES` from constants and `getPhaseTasks` from storage — same pattern as AutomationSettings.jsx uses for task selection.

Add the DocuSign settings section in the main `AdminSettings` return, between the RingCentral section and the "Other Integrations" label:

```jsx
{/* DocuSign eSignature Integration */}
<div style={{ marginBottom: 20 }}>
  <DocuSignSettings showToast={showToast} />
</div>
```

Also add a DocuSign entry to the "Other Integrations" grid as an `IntegrationInfoCard`.

**Step 2: Verify the settings page**

Run `npm run dev`, log in as admin, go to Settings. The DocuSign section should show:
- Environment setting (EditableSetting)
- Template list with add/edit/remove
- Connection status card

**Step 3: Commit**

```bash
git add src/components/AdminSettings.jsx
git commit -m "feat: add DocuSign template configuration to Admin Settings"
```

---

## Task 7: Add Automation Trigger and Action

**Files:**
- Modify: `src/components/AutomationSettings.jsx`
- Modify: `src/lib/automations.js`

**Step 1: Update AutomationSettings.jsx**

In `TRIGGER_OPTIONS` array, add before the `interview_scheduled` entry:
```javascript
{ value: 'document_signed', label: 'Document Signed', description: 'Fires when a DocuSign envelope is fully signed' },
```

In `ACTION_OPTIONS` array, add at the end:
```javascript
{ value: 'send_docusign_envelope', label: 'Send DocuSign Envelope', description: 'Send document(s) for eSignature via DocuSign' },
```

In `MERGE_FIELDS` array, add:
```javascript
{ key: 'signed_documents', label: 'Signed Documents', triggers: ['document_signed'] },
```

In the `TriggerBadge` component, add to `colors`:
```javascript
document_signed: { bg: '#F0FDF4', color: '#15803D', border: '#BBF7D0' },
```

And to `labels`:
```javascript
document_signed: 'Doc Signed',
```

In the `ActionBadge` component, add to `config`:
```javascript
send_docusign_envelope: { bg: '#F5F3FF', color: '#6D28D9', border: '#DDD6FE', label: 'DocuSign' },
```

In the `RuleForm` component, add a condition section for `document_signed` trigger (similar to `document_uploaded` pattern — optional filter for specific template). Also add action config for `send_docusign_envelope` (template selection: "all" for full packet, or specific template IDs).

In the `RuleForm` validation, add:
```javascript
if (actionType === 'send_docusign_envelope' && !docusignTemplateConfig) { setError('Select which templates to send.'); return; }
```

In the `RulesList` component, add display logic for `document_signed` trigger details and `send_docusign_envelope` action details.

**Step 2: Update automations.js**

In the `evaluateConditions` function, add condition matching for `document_signed`:

```javascript
// For document_signed trigger: match specific template name
if (conds.template_name && triggerContext.template_name !== conds.template_name) return false;
```

No other changes needed — `fireEventTriggers` is generic and already handles any trigger type.

**Step 3: Commit**

```bash
git add src/components/AutomationSettings.jsx src/lib/automations.js
git commit -m "feat: add document_signed trigger and send_docusign_envelope action to automation engine"
```

---

## Task 8: Update AI Chat Tools

**Files:**
- Modify: `ai-chat` Edge Function (deployed via Supabase MCP)

**Step 1: Add 3 DocuSign tools to the ai-chat Edge Function**

Update the `ai-chat` Edge Function (v25 → v26) to add these tools:

**Tool definitions** (add to the `tools` array):

```javascript
{
  name: 'send_docusign_envelope',
  description: 'Send DocuSign document(s) for eSignature to a caregiver. Requires confirmation.',
  input_schema: {
    type: 'object',
    properties: {
      caregiver_id: { type: 'string', description: 'Caregiver ID' },
      template_ids: { type: 'array', items: { type: 'string' }, description: 'Template IDs to send, or omit for full packet' },
    },
    required: ['caregiver_id'],
  },
},
{
  name: 'get_envelope_status',
  description: 'Check DocuSign envelope signing status for a caregiver',
  input_schema: {
    type: 'object',
    properties: {
      caregiver_id: { type: 'string', description: 'Caregiver ID' },
    },
    required: ['caregiver_id'],
  },
},
{
  name: 'list_docusign_envelopes',
  description: 'List all DocuSign envelopes sent to a caregiver',
  input_schema: {
    type: 'object',
    properties: {
      caregiver_id: { type: 'string', description: 'Caregiver ID' },
    },
    required: ['caregiver_id'],
  },
},
```

**Tool handlers:**

- `send_docusign_envelope` — Medium risk, needs confirmation card. Look up caregiver, build confirmation message ("Send Employment Agreement to maria@email.com?"), return pendingConfirmation. On confirm, call `docusign-integration` Edge Function.
- `get_envelope_status` — Low risk, query `docusign_envelopes` table, return status summary.
- `list_docusign_envelopes` — Low risk, query `docusign_envelopes` table, return list.

Follow the exact same confirmation pattern used by `send_sms`, `send_email`, etc.

**Step 2: Deploy updated ai-chat**

Deploy via Supabase MCP `deploy_edge_function`.

**Step 3: No git commit** — Edge Functions not in git.

---

## Task 9: Update execute-automation Edge Function

**Files:**
- Modify: `execute-automation` Edge Function (deployed via Supabase MCP)

**Step 1: Add `send_docusign_envelope` action handler**

Update `execute-automation` (v3 → v4) to handle the new action type.

When `action_type === 'send_docusign_envelope'`:
- Read `action_config` for `template_ids` (array, or `"all"` for full packet)
- If `"all"`, fetch all templates from `docusign_templates` app_setting
- Call `docusign-integration` Edge Function with `action: 'send_envelope'` or `action: 'send_packet'`
- Log result to `automation_log`
- Add auto-note if `message_template` is provided

Follow the same pattern as existing actions (send_sms, send_email, etc.).

**Step 2: Deploy updated execute-automation**

Deploy via Supabase MCP `deploy_edge_function`.

**Step 3: No git commit** — Edge Functions not in git.

---

## Task 10: Build and Verify

**Step 1: Run the build**

```bash
cd "C:\Users\nashk\OneDrive\Desktop\Claude Caregiver Portal\caregiver-portal-improvements"
npm run build
```

Expected: Build succeeds with no errors.

**Step 2: Fix any build errors**

If there are import errors, missing exports, or CSS module issues, fix them and re-run build.

**Step 3: Run dev server and manual smoke test**

```bash
npm run dev
```

Verify:
1. Documents tab shows "DocuSign eSignatures" collapsible section
2. Admin Settings shows DocuSign configuration section
3. AutomationSettings shows `Document Signed` trigger and `Send DocuSign Envelope` action options
4. No console errors on page load

**Step 4: Final commit**

```bash
git add -A
git commit -m "feat: DocuSign integration build verification and fixes"
```

---

## Task 11: Push Branch

**Step 1: Push the feature branch**

```bash
git push -u origin feature/docusign-integration
```

**Step 2: Verify push succeeded**

```bash
git log --oneline -10
```

Expected: All commits visible on the feature branch.

---

## Summary of Commits

1. `feat: add DocuSign envelope status constants`
2. `feat: add DocuSignSection component with send and status UI`
3. `feat: render DocuSignSection inside Documents tab`
4. `feat: add DocuSign template configuration to Admin Settings`
5. `feat: add document_signed trigger and send_docusign_envelope action to automation engine`
6. `feat: DocuSign integration build verification and fixes`

## Edge Function Deployments (not in git)

1. `docusign-integration` — New Edge Function (send, webhook, status, test)
2. `ai-chat` v25 → v26 — Add 3 DocuSign tools
3. `execute-automation` v3 → v4 — Add `send_docusign_envelope` action

## Migration Applied (not in git)

1. `create_docusign_envelopes_table` — Table + RLS + indexes
