// Phase 0.5 PR B — editable manifest detail view.
//
// Per-field [Edit] buttons open ManifestFieldEdit modals. Changes are
// staged in local "draft" state without hitting the database. The
// top-level [Save changes…] button opens SaveConfirmationDialog with
// the diff; on confirm, the RPC is called and the parent refetches.
//
// Read-only fields (slug, triggers, version metadata) stay
// non-editable per the locked spec §2.

import { useEffect, useMemo, useState } from 'react';
import { AgentVersionHistory } from './AgentVersionHistory';
import { ManifestFieldEdit } from './ManifestFieldEdit';
import { SaveConfirmationDialog } from './SaveConfirmationDialog';
import { useUpdateAgent } from './useUpdateAgent';
import { isManifestUnchanged, buildUpdatePayload, deepEqual } from './diff';
import { toolUniverseForAgent } from './toolUniverse';

export function AgentManifestEditor({ agent, showToast, onSaved }) {
  // All hooks must run unconditionally on every render. We bail out of
  // the JSX tree at the bottom if `agent` is missing.
  const [draft, setDraft]                 = useState(() => agent || EMPTY_DRAFT);
  const [editingField, setEditingField]   = useState(null);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [conflictAt, setConflictAt]       = useState(null);
  const { saving, save }                  = useUpdateAgent();

  // Sync draft when the agent prop changes (parent refetched after save
  // or revert, or the user expanded a different agent). We re-base on
  // id+version so unrelated re-renders don't blow away local edits.
  useEffect(() => {
    if (!agent) return;
    setDraft(agent);
    setConflictAt(null);
  }, [agent?.id, agent?.version]);

  const knownTools = useMemo(
    () => toolUniverseForAgent(agent?.slug || ''),
    [agent?.slug],
  );
  const unchanged = !agent ? true : isManifestUnchanged(agent, draft);
  const dirtyFields = useMemo(() => {
    if (!agent) return new Set();
    const fields = ['name', 'system_prompt', 'tool_allowlist', 'autonomy_profile',
                    'context_recipe', 'model', 'max_iterations', 'outcome_definition'];
    return new Set(fields.filter(f => !deepEqual(agent[f], draft?.[f])));
  }, [agent, draft]);

  if (!agent) return null;

  const updateField = (field, value) => {
    setDraft(prev => ({ ...prev, [field]: value }));
    setEditingField(null);
  };

  const discardDraft = () => {
    setDraft(agent);
    setConflictAt(null);
  };

  const handleSaveConfirm = async (changeSummary) => {
    const updates = buildUpdatePayload(agent, draft);
    const result = await save({
      agentId: agent.id,
      expectedVersion: agent.version,
      updates,
      changeSummary,
    });

    if (result.success) {
      setShowSaveDialog(false);
      showToast?.(`Saved as version ${result.newVersion}`);
      onSaved?.();
    } else if (result.conflict) {
      setShowSaveDialog(false);
      setConflictAt(agent.version);
    } else {
      const code = result.error?.code || result.error?.message || 'unknown';
      showToast?.(`Save failed: ${code}`);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Top action bar — Save + Discard when dirty */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '6px 0',
        }}
      >
        <div style={{ fontSize: 12, color: '#6B7280' }}>
          Editing as draft. Changes don't take effect until you save.
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {!unchanged && (
            <button type="button" onClick={discardDraft} style={btnSecondary}>
              Discard changes
            </button>
          )}
          <button
            type="button"
            disabled={unchanged}
            onClick={() => setShowSaveDialog(true)}
            style={{
              ...btnPrimary,
              opacity: unchanged ? 0.5 : 1,
              cursor: unchanged ? 'not-allowed' : 'pointer',
            }}
          >
            Save changes…
          </button>
        </div>
      </div>

      {/* Conflict banner */}
      {conflictAt !== null && (
        <div
          style={{
            background: '#FEF3C7',
            border: '1px solid #FDE68A',
            color: '#92400E',
            padding: '12px 16px',
            borderRadius: 6,
            fontSize: 13,
          }}
        >
          <strong>Version conflict.</strong> Another admin saved this agent
          while you were editing (you were on v{conflictAt}, the database
          has moved on). Your edits are preserved locally — discard them
          or wait for the next refresh to re-base. The parent reloads
          automatically when you close and re-expand this row.
        </div>
      )}

      <Field
        label="Display name"
        value={draft.name}
        dirty={dirtyFields.has('name')}
        onEdit={() => setEditingField({ field: 'name', type: 'text', label: 'Display name' })}
      />
      <Field
        label="Slug (read-only)"
        value={draft.slug}
        mono
        readOnly
      />
      <Field
        label="Model"
        value={draft.model}
        mono
        dirty={dirtyFields.has('model')}
        onEdit={() => setEditingField({ field: 'model', type: 'text', label: 'Model' })}
      />
      <Field
        label="Max iterations"
        value={String(draft.max_iterations)}
        dirty={dirtyFields.has('max_iterations')}
        onEdit={() => setEditingField({ field: 'max_iterations', type: 'number', label: 'Max iterations' })}
      />

      <Block
        label="System prompt"
        dirty={dirtyFields.has('system_prompt')}
        onEdit={() => setEditingField({ field: 'system_prompt', type: 'textarea', label: 'System prompt' })}
      >
        <pre style={preStyle}>{draft.system_prompt || '(empty)'}</pre>
      </Block>

      <Block
        label={`Tool allowlist (${(draft.tool_allowlist || []).length} of ${knownTools.length})`}
        dirty={dirtyFields.has('tool_allowlist')}
        onEdit={() => setEditingField({ field: 'tool_allowlist', type: 'multiselect', label: 'Tool allowlist' })}
      >
        {(draft.tool_allowlist || []).length === 0 ? (
          <div style={{ color: '#6B7280', fontSize: 13 }}>(none)</div>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
              gap: 6,
              fontSize: 12,
              fontFamily: monoFont,
            }}
          >
            {draft.tool_allowlist.map(tool => (
              <span key={tool} style={{ color: '#374151' }}>
                ✓ {tool}
              </span>
            ))}
          </div>
        )}
      </Block>

      <Block
        label="Autonomy profile"
        dirty={dirtyFields.has('autonomy_profile')}
        onEdit={() => setEditingField({ field: 'autonomy_profile', type: 'json', label: 'Autonomy profile' })}
      >
        <JsonView value={draft.autonomy_profile} />
      </Block>

      <Block
        label="Context recipe"
        dirty={dirtyFields.has('context_recipe')}
        onEdit={() => setEditingField({ field: 'context_recipe', type: 'json', label: 'Context recipe' })}
      >
        <JsonView value={draft.context_recipe} />
      </Block>

      <Block label="Triggers (read-only — coupled to deployed cron entries)" readOnly>
        <JsonView value={draft.triggers} />
      </Block>

      <Block
        label="Outcome definition"
        dirty={dirtyFields.has('outcome_definition')}
        onEdit={() => setEditingField({ field: 'outcome_definition', type: 'json', label: 'Outcome definition' })}
      >
        <JsonView value={draft.outcome_definition} />
      </Block>

      <Block label="Version history">
        <AgentVersionHistory
          agentId={agent.id}
          currentVersion={agent.version}
          onRevert={onSaved}
          showToast={showToast}
        />
      </Block>

      <div style={{ fontSize: 11, color: '#9CA3AF', paddingTop: 8, borderTop: '1px dashed #E5E7EB' }}>
        Created {fmtDate(agent.created_at)}
        {agent.created_by ? ` by ${agent.created_by}` : ''}
        {' · '}
        Last updated {fmtDate(agent.updated_at)}
        {agent.updated_by ? ` by ${agent.updated_by}` : ''}
      </div>

      {/* Per-field edit modal */}
      {editingField && (
        <ManifestFieldEdit
          field={editingField.field}
          label={editingField.label}
          fieldType={editingField.type}
          knownTools={knownTools}
          initialValue={draft[editingField.field]}
          onSave={(v) => updateField(editingField.field, v)}
          onClose={() => setEditingField(null)}
        />
      )}

      {/* Save confirmation modal */}
      {showSaveDialog && (
        <SaveConfirmationDialog
          current={agent}
          proposed={draft}
          defaultSummary=""
          busy={saving}
          onConfirm={handleSaveConfirm}
          onClose={() => setShowSaveDialog(false)}
        />
      )}
    </div>
  );
}

function Field({ label, value, mono, dirty, readOnly, onEdit }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
      <span style={{ fontSize: 12, fontWeight: 500, color: '#6B7280', minWidth: 140 }}>
        {label}:
      </span>
      <span
        style={{
          fontSize: 13,
          color: '#111827',
          fontFamily: mono ? monoFont : 'inherit',
          flex: 1,
        }}
      >
        {value || <em style={{ color: '#9CA3AF' }}>(empty)</em>}
      </span>
      {dirty && <DirtyBadge />}
      {!readOnly && onEdit && (
        <button type="button" onClick={onEdit} style={editBtnStyle}>
          Edit
        </button>
      )}
    </div>
  );
}

function Block({ label, dirty, readOnly, onEdit, children }) {
  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 6,
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 500, color: '#6B7280' }}>
          {label}
        </span>
        {dirty && <DirtyBadge />}
        {!readOnly && onEdit && (
          <button type="button" onClick={onEdit} style={{ ...editBtnStyle, marginLeft: 'auto' }}>
            Edit
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

function DirtyBadge() {
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 600,
        color: '#92400E',
        background: '#FEF3C7',
        padding: '1px 6px',
        borderRadius: 4,
        textTransform: 'uppercase',
        letterSpacing: 0.4,
      }}
      title="Modified locally — click Save changes to persist"
    >
      Edited
    </span>
  );
}

function JsonView({ value }) {
  let pretty;
  try {
    pretty = JSON.stringify(value ?? {}, null, 2);
  } catch {
    pretty = String(value);
  }
  return <pre style={preStyleSmall}>{pretty}</pre>;
}

function fmtDate(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

// Sentinel used as initial state when agent prop is briefly null —
// keeps useState typed and avoids "draft might be null" guards in
// every dirty-check.
const EMPTY_DRAFT = {
  id: null, slug: '', name: '', version: 0,
  system_prompt: '', tool_allowlist: [],
  autonomy_profile: {}, context_recipe: {}, outcome_definition: {},
  triggers: {},
  model: '', max_iterations: 1,
  kill_switch: false, shadow_mode: false,
  created_at: null, updated_at: null, created_by: null, updated_by: null,
};

const monoFont = 'ui-monospace, SFMono-Regular, Menlo, monospace';

const preStyle = {
  margin: 0,
  padding: 12,
  background: '#FFFFFF',
  border: '1px solid #E5E7EB',
  borderRadius: 6,
  fontSize: 12,
  fontFamily: monoFont,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  maxHeight: 240,
  overflow: 'auto',
};

const preStyleSmall = {
  ...preStyle,
  fontSize: 11,
  maxHeight: 200,
};

const editBtnStyle = {
  fontSize: 11,
  fontWeight: 500,
  padding: '4px 10px',
  borderRadius: 4,
  border: '1px solid #D1D5DB',
  background: '#FFFFFF',
  color: '#374151',
  cursor: 'pointer',
};

const btnPrimary = {
  padding: '6px 14px',
  borderRadius: 6,
  border: '1px solid #4338CA',
  background: '#4F46E5',
  color: '#FFFFFF',
  fontSize: 13,
  fontWeight: 500,
};

const btnSecondary = {
  padding: '6px 14px',
  borderRadius: 6,
  border: '1px solid #D1D5DB',
  background: '#FFFFFF',
  color: '#374151',
  fontSize: 13,
  fontWeight: 500,
  cursor: 'pointer',
};
