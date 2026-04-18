import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import {
  TASK_CATEGORIES,
  sectionIdForCategory,
  sectionUsesTasks,
  sortedSections,
} from './sections';
import {
  createCarePlan,
  getCarePlanForClient,
  getTasksForVersion,
  listVersions,
} from './storage';
import btn from '../../styles/buttons.module.css';
import s from './CarePlanPanel.module.css';

// ═══════════════════════════════════════════════════════════════
// CarePlanPanel — Phase 2a (read-only preview)
//
// Drop-in section on the client detail page. Shows the clinical
// care plan structure and any data that has been entered. Editing
// arrives in Phase 2b — this PR ships the schema, storage layer,
// and read-only shell so the foundation is solid before we layer
// on forms.
//
// States:
//   - loading            spinner while fetching
//   - empty              "Create care plan" CTA
//   - created / active   16 section cards, version header, history
//
// Realtime: subscribes to `care_plan_versions` for this plan so a
// publish in another tab (or by the AI in a later phase) appears
// here without a refresh.
// ═══════════════════════════════════════════════════════════════

export function CarePlanPanel({ client, currentUser, showToast }) {
  const [plan, setPlan] = useState(null);
  const [currentVersion, setCurrentVersion] = useState(null);
  const [versions, setVersions] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [creating, setCreating] = useState(false);

  // ─── Load ────────────────────────────────────────────────────
  const load = useCallback(async () => {
    if (!client?.id) return;
    try {
      const result = await getCarePlanForClient(client.id);
      if (!result) {
        setPlan(null);
        setCurrentVersion(null);
        setVersions([]);
        setTasks([]);
        setLoadError(null);
        return;
      }
      setPlan(result.plan);
      setCurrentVersion(result.currentVersion);
      // Load version history + tasks in parallel
      const [allVersions, currentTasks] = await Promise.all([
        listVersions(result.plan.id),
        result.currentVersion
          ? getTasksForVersion(result.currentVersion.id)
          : Promise.resolve([]),
      ]);
      setVersions(allVersions);
      setTasks(currentTasks);
      setLoadError(null);
    } catch (e) {
      console.error('CarePlanPanel load error:', e);
      setLoadError(e.message || 'Failed to load care plan');
    } finally {
      setLoading(false);
    }
  }, [client?.id]);

  useEffect(() => {
    load();
  }, [load]);

  // ─── Realtime: watch for version changes on this plan ───────
  useEffect(() => {
    if (!supabase || !plan?.id) return undefined;
    const channel = supabase
      .channel(`care-plan-${plan.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'care_plan_versions',
          filter: `care_plan_id=eq.${plan.id}`,
        },
        () => load(),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [plan?.id, load]);

  // ─── Create care plan action ─────────────────────────────────
  const handleCreate = async () => {
    if (!client?.id || creating) return;
    setCreating(true);
    setLoadError(null);
    try {
      const result = await createCarePlan(client.id, {
        createdBy: currentUser?.displayName || currentUser?.email || null,
      });
      if (result) {
        setPlan(result.plan);
        setCurrentVersion(result.currentVersion);
        setVersions([result.currentVersion]);
        setTasks([]);
        showToast?.('Care plan created (v1 draft)');
      }
    } catch (e) {
      console.error('Create care plan failed:', e);
      setLoadError(e.message || 'Failed to create care plan');
    } finally {
      setCreating(false);
    }
  };

  // ─── Group tasks by section for the section cards ────────────
  const tasksBySection = tasks.reduce((acc, task) => {
    const sectionId = sectionIdForCategory(task.category);
    if (!sectionId) return acc;
    if (!acc[sectionId]) acc[sectionId] = [];
    acc[sectionId].push(task);
    return acc;
  }, {});

  // ─── Render ──────────────────────────────────────────────────
  return (
    <section className={s.panel}>
      <header className={s.header}>
        <div>
          <h3 className={s.title}>Care Plan</h3>
          <p className={s.subtitle}>
            Clinical assessment and plan of care. Everything we learn about{' '}
            {client?.firstName || 'this client'} over time.
          </p>
        </div>
        <span className={s.previewBadge} title="Editing ships in the next release">
          Read-only preview
        </span>
      </header>

      {loading && <div className={s.loading}>Loading care plan…</div>}

      {loadError && (
        <div className={s.errorBanner}>Could not load care plan: {loadError}</div>
      )}

      {!loading && !plan && (
        <div className={s.emptyState}>
          <p className={s.emptyText}>
            No care plan yet. Start one to begin capturing assessment,
            medications, ADL tasks, routines, and goals.
          </p>
          <button
            className={btn.primaryBtn}
            onClick={handleCreate}
            disabled={creating}
          >
            {creating ? 'Creating…' : 'Create care plan'}
          </button>
        </div>
      )}

      {!loading && plan && (
        <>
          <VersionHeader version={currentVersion} />

          <ul className={s.sectionList}>
            {sortedSections().map((section) => (
              <SectionCard
                key={section.id}
                section={section}
                data={currentVersion?.data?.[section.id]}
                tasks={sectionUsesTasks(section) ? tasksBySection[section.id] : null}
              />
            ))}
          </ul>

          {versions.length > 0 && (
            <details className={s.history}>
              <summary className={s.historySummary}>
                Version history ({versions.length})
              </summary>
              <ul className={s.historyList}>
                {versions.map((v) => (
                  <li key={v.id} className={s.historyRow}>
                    <span className={s.historyVersion}>v{v.versionNumber}</span>
                    <span
                      className={`${s.historyStatus} ${
                        s[`historyStatus_${v.status}`] || ''
                      }`}
                    >
                      {v.status}
                    </span>
                    <span className={s.historyMeta}>
                      {formatDateTime(v.status === 'published' ? v.publishedAt : v.createdAt)}
                      {v.versionReason && ` · ${v.versionReason}`}
                      {v.createdBy && ` · ${v.createdBy}`}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}


// ─── VersionHeader ────────────────────────────────────────────

function VersionHeader({ version }) {
  if (!version) return null;
  const isDraft = version.status === 'draft';
  const dateLabel = isDraft
    ? `Started ${formatDate(version.createdAt)}`
    : `Published ${formatDate(version.publishedAt)}`;
  const who = isDraft ? version.createdBy : version.publishedBy;
  return (
    <div className={s.versionHeader}>
      <span
        className={`${s.versionPill} ${s[`versionPill_${version.status}`] || ''}`}
      >
        {isDraft ? 'Draft' : version.status === 'published' ? 'Published' : version.status}{' '}
        v{version.versionNumber}
      </span>
      <span className={s.versionMeta}>
        {dateLabel}
        {who && ` by ${who}`}
        {version.versionReason && ` · ${version.versionReason}`}
      </span>
    </div>
  );
}


// ─── SectionCard ──────────────────────────────────────────────

function SectionCard({ section, data, tasks }) {
  const usesTasks = sectionUsesTasks(section);
  const hasData = usesTasks
    ? Array.isArray(tasks) && tasks.length > 0
    : data && hasMeaningfulContent(data);

  return (
    <li className={s.sectionCard}>
      <div className={s.sectionHeader}>
        <div>
          <h4 className={s.sectionTitle}>
            {section.label}
            {section.isAutoGenerated && (
              <span className={s.autoTag} title="AI-generated section">
                AI
              </span>
            )}
          </h4>
          <p className={s.sectionDescription}>{section.description}</p>
        </div>
      </div>

      <div className={s.sectionBody}>
        {!hasData && <div className={s.empty}>Not entered yet.</div>}

        {hasData && usesTasks && <TaskList tasks={tasks} />}

        {hasData && !usesTasks && <NarrativeAndFields data={data} />}
      </div>
    </li>
  );
}


// ─── Task list (for ADL / IADL sections) ─────────────────────

function TaskList({ tasks }) {
  // Group by category so "Bathing" tasks cluster, "Dressing" tasks cluster, etc.
  const groups = tasks.reduce((acc, task) => {
    if (!acc[task.category]) acc[task.category] = [];
    acc[task.category].push(task);
    return acc;
  }, {});
  const orderedCategories = Object.keys(groups).sort();

  return (
    <div className={s.taskGroups}>
      {orderedCategories.map((category) => {
        const label = TASK_CATEGORIES[category]?.label || category;
        return (
          <div key={category} className={s.taskGroup}>
            <div className={s.taskGroupLabel}>{label}</div>
            <ul className={s.taskList}>
              {groups[category].map((task) => (
                <li key={task.id} className={s.taskRow}>
                  <div className={s.taskName}>
                    {task.taskName}
                    {task.priority === 'critical' && (
                      <span className={s.criticalTag}>critical</span>
                    )}
                  </div>
                  {task.description && (
                    <div className={s.taskDescription}>{task.description}</div>
                  )}
                  {task.safetyNotes && (
                    <div className={s.taskSafety}>
                      <strong>Safety:</strong> {task.safetyNotes}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}


// ─── Narrative + fields rendering (non-task sections) ────────

function NarrativeAndFields({ data }) {
  // Phase 2a stub: render the narrative if present, then any other
  // top-level string / number / boolean fields as a definition list.
  // Phase 2b will replace this with proper per-section read-only
  // rendering using the field definitions from sections.js.
  const narrative = typeof data?.narrative === 'string' ? data.narrative : null;
  const fields = Object.entries(data || {}).filter(([key]) => key !== 'narrative');

  return (
    <div>
      {narrative && <p className={s.narrative}>{narrative}</p>}
      {fields.length > 0 && (
        <dl className={s.fieldList}>
          {fields.map(([key, value]) => (
            <div key={key} className={s.fieldRow}>
              <dt className={s.fieldLabel}>{humanizeKey(key)}</dt>
              <dd className={s.fieldValue}>{formatFieldValue(value)}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}


// ─── Formatting helpers ───────────────────────────────────────

function hasMeaningfulContent(data) {
  if (!data || typeof data !== 'object') return false;
  if (typeof data.narrative === 'string' && data.narrative.trim().length > 0) {
    return true;
  }
  const otherKeys = Object.keys(data).filter((k) => k !== 'narrative');
  for (const key of otherKeys) {
    const v = data[key];
    if (v == null) continue;
    if (typeof v === 'string' && v.trim().length === 0) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    return true;
  }
  return false;
}

function formatFieldValue(v) {
  if (v == null) return '—';
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function humanizeKey(key) {
  // Convert camelCase / snake_case to "Title Case" for read-only display.
  return String(key)
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

function formatDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}

function formatDateTime(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

