import { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { getClientPhase, isTaskDone } from '../../features/clients/utils';
import { CLIENT_PHASES } from '../../features/clients/constants';
import { loadClients, saveClient, saveClientsBulk, deleteClientsFromDb, dbToClient, getClientPhaseTasks, saveClientPhaseTasks, loadClientPhaseTasks } from '../../features/clients/storage';
import { supabase, isSupabaseConfigured } from '../../lib/supabase';
import { fireClientEventTriggers } from '../../features/clients/automations';
import { useApp } from './AppContext';

// ─── Auto-advance helper ────────────────────────────────────
// Returns the next pipeline phase if all tasks in the current phase are done.
// Skips terminal phases (won/lost/nurture) — those require manual selection.
const ADVANCEABLE_PHASES = CLIENT_PHASES
  .filter((p) => !['won', 'lost', 'nurture'].includes(p.id))
  .map((p) => p.id);

function getAutoAdvancePhase(client, tasksObj) {
  const currentPhase = getClientPhase(client);
  // Only auto-advance through pipeline phases
  const idx = ADVANCEABLE_PHASES.indexOf(currentPhase);
  if (idx < 0 || idx >= ADVANCEABLE_PHASES.length - 1) return null;

  const phaseTasks = getClientPhaseTasks()[currentPhase] || [];
  if (phaseTasks.length === 0) return null;

  const allDone = phaseTasks.every((t) => isTaskDone(tasksObj?.[t.id]));
  if (!allDone) return null;

  return ADVANCEABLE_PHASES[idx + 1];
}

const ClientContext = createContext();

export function ClientProvider({ children }) {
  const { showToast, currentUserName } = useApp();

  const [clients, setClients] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [tasksVersion, setTasksVersion] = useState(0);
  const [filterPhase, setFilterPhase] = useState('all');

  // ─── Load data on mount (with retry) ───
  useEffect(() => {
    let cancelled = false;
    const load = async (attempt = 1) => {
      try {
        await loadClientPhaseTasks();
        const data = await loadClients();
        if (cancelled) return;
        setClients(data);
        setTasksVersion((v) => v + 1);
        setLoaded(true);
        if (data.length === 0 && isSupabaseConfigured() && attempt === 1) {
          setTimeout(() => { if (!cancelled) load(2); }, 1500);
        }
      } catch (err) {
        console.error('Client data load failed (attempt ' + attempt + '):', err);
        if (attempt < 3 && !cancelled) {
          setTimeout(() => load(attempt + 1), 1000 * attempt);
        } else if (!cancelled) {
          setLoaded(true);
        }
      }
    };
    load();
    return () => { cancelled = true; };
  }, []);

  // ─── Realtime subscription for automation-driven changes ───
  useEffect(() => {
    if (!isSupabaseConfigured()) return;

    const channel = supabase
      .channel('clients-changes')
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'clients' },
        (payload) => {
          const updatedRow = payload.new;
          if (!updatedRow?.id) return;
          const mapped = dbToClient(updatedRow);
          setClients((prev) =>
            prev.map((cl) => cl.id === mapped.id ? { ...cl, ...mapped } : cl)
          );
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, []);

  // ─── Client CRUD ───
  const addClient = useCallback((data) => {
    const newClient = {
      id: crypto.randomUUID(),
      ...data,
      tasks: {},
      notes: [],
      phase: 'new_lead',
      phaseTimestamps: { new_lead: Date.now() },
      priority: data.priority || 'normal',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    setClients((prev) => [newClient, ...prev]);
    saveClient(newClient).catch(() => showToast('Failed to save \u2014 check your connection'));
    fireClientEventTriggers('new_client', newClient);
    showToast(`${data.firstName || ''} ${data.lastName || ''} added as new client!`);
    return newClient;
  }, [showToast]);

  const updateClient = useCallback((clientId, updates) => {
    let changed;
    let oldPhase;
    setClients((prev) =>
      prev.map((cl) => {
        if (cl.id !== clientId) return cl;
        oldPhase = getClientPhase(cl);
        changed = { ...cl, ...updates, updatedAt: Date.now() };
        return changed;
      })
    );
    if (changed) {
      saveClient(changed).catch(() => showToast('Failed to save \u2014 check your connection'));
      const newPhase = getClientPhase(changed);
      if (oldPhase && newPhase !== oldPhase) {
        fireClientEventTriggers('client_phase_change', changed, { from_phase: oldPhase, to_phase: newPhase });
      }
    }
    showToast('Client updated!');
  }, [showToast]);

  const updatePhase = useCallback((clientId, newPhase) => {
    let changed;
    let oldPhase;
    setClients((prev) =>
      prev.map((cl) => {
        if (cl.id !== clientId) return cl;
        oldPhase = getClientPhase(cl);
        changed = {
          ...cl,
          phase: newPhase,
          phaseTimestamps: {
            ...cl.phaseTimestamps,
            [newPhase]: cl.phaseTimestamps?.[newPhase] || Date.now(),
          },
          updatedAt: Date.now(),
        };
        return changed;
      })
    );
    if (changed) {
      saveClient(changed).catch(() => showToast('Failed to save \u2014 check your connection'));
      if (oldPhase && newPhase !== oldPhase) {
        fireClientEventTriggers('client_phase_change', changed, { from_phase: oldPhase, to_phase: newPhase });
      }
    }
  }, [showToast]);

  const updateTask = useCallback((clientId, taskId, value) => {
    const taskValue = value ? { completed: true, completedAt: Date.now(), completedBy: currentUserName } : false;
    let changed;
    let oldPhase;
    setClients((prev) =>
      prev.map((cl) => {
        if (cl.id !== clientId) return cl;
        oldPhase = getClientPhase(cl);
        const newTasks = { ...cl.tasks, [taskId]: taskValue };
        changed = {
          ...cl,
          tasks: newTasks,
          updatedAt: Date.now(),
        };
        // Auto-advance: if all tasks in current phase are done, move to next phase
        if (value) {
          const nextPhase = getAutoAdvancePhase(cl, newTasks);
          if (nextPhase) {
            changed.phase = nextPhase;
            changed.phaseTimestamps = {
              ...changed.phaseTimestamps,
              [nextPhase]: changed.phaseTimestamps?.[nextPhase] || Date.now(),
            };
          }
        }
        return changed;
      })
    );
    if (changed) {
      saveClient(changed).catch(() => showToast('Failed to save \u2014 check your connection'));
      if (value) {
        fireClientEventTriggers('client_task_completed', changed, { task_id: taskId });
      }
      const newPhase = getClientPhase(changed);
      if (oldPhase && newPhase !== oldPhase) {
        fireClientEventTriggers('client_phase_change', changed, { from_phase: oldPhase, to_phase: newPhase });
        showToast(`Advanced to ${CLIENT_PHASES.find((p) => p.id === newPhase)?.label || newPhase}!`);
      }
    }
  }, [showToast, currentUserName]);

  const updateTasksBulk = useCallback((clientId, taskUpdates) => {
    const enriched = {};
    for (const [key, val] of Object.entries(taskUpdates)) {
      enriched[key] = val ? { completed: true, completedAt: Date.now(), completedBy: currentUserName } : false;
    }
    let changed;
    let oldPhase;
    setClients((prev) =>
      prev.map((cl) => {
        if (cl.id !== clientId) return cl;
        oldPhase = getClientPhase(cl);
        const newTasks = { ...cl.tasks, ...enriched };
        changed = {
          ...cl,
          tasks: newTasks,
          updatedAt: Date.now(),
        };
        // Auto-advance: if all tasks in current phase are done, move to next phase
        const hasAnyChecked = Object.values(taskUpdates).some(Boolean);
        if (hasAnyChecked) {
          const nextPhase = getAutoAdvancePhase(cl, newTasks);
          if (nextPhase) {
            changed.phase = nextPhase;
            changed.phaseTimestamps = {
              ...changed.phaseTimestamps,
              [nextPhase]: changed.phaseTimestamps?.[nextPhase] || Date.now(),
            };
          }
        }
        return changed;
      })
    );
    if (changed) {
      saveClient(changed).catch(() => showToast('Failed to save \u2014 check your connection'));
      for (const [key, val] of Object.entries(taskUpdates)) {
        if (val) fireClientEventTriggers('client_task_completed', changed, { task_id: key });
      }
      const newPhase = getClientPhase(changed);
      if (oldPhase && newPhase !== oldPhase) {
        fireClientEventTriggers('client_phase_change', changed, { from_phase: oldPhase, to_phase: newPhase });
        showToast(`Advanced to ${CLIENT_PHASES.find((p) => p.id === newPhase)?.label || newPhase}!`);
      }
    }
  }, [showToast, currentUserName]);

  const addNote = useCallback((clientId, noteData) => {
    const note = typeof noteData === 'string'
      ? { text: noteData, timestamp: Date.now(), author: currentUserName, type: 'note' }
      : { ...noteData, timestamp: Date.now(), author: noteData.author || currentUserName };
    let changed;
    setClients((prev) =>
      prev.map((cl) => {
        if (cl.id !== clientId) return cl;
        changed = { ...cl, notes: [...(cl.notes || []), note], updatedAt: Date.now() };
        return changed;
      })
    );
    if (changed) saveClient(changed).catch(() => showToast('Failed to save \u2014 check your connection'));
  }, [showToast, currentUserName]);

  const archiveClient = useCallback((clientId, reason, detail) => {
    let changed;
    setClients((prev) =>
      prev.map((cl) => {
        if (cl.id !== clientId) return cl;
        changed = {
          ...cl,
          archived: true,
          archivedAt: Date.now(),
          archiveReason: reason,
          archiveDetail: detail || '',
          updatedAt: Date.now(),
        };
        return changed;
      })
    );
    if (changed) saveClient(changed).catch(() => showToast('Failed to save \u2014 check your connection'));
    showToast('Client archived');
  }, [showToast]);

  const unarchiveClient = useCallback((clientId) => {
    let changed;
    setClients((prev) =>
      prev.map((cl) => {
        if (cl.id !== clientId) return cl;
        changed = {
          ...cl,
          archived: false,
          archivedAt: null,
          archiveReason: null,
          archiveDetail: null,
          updatedAt: Date.now(),
        };
        return changed;
      })
    );
    if (changed) saveClient(changed).catch(() => showToast('Failed to save \u2014 check your connection'));
    showToast('Client restored to pipeline');
  }, [showToast]);

  const deleteClient = useCallback(async (clientId) => {
    try {
      await deleteClientsFromDb([clientId]);
      setClients((prev) => prev.filter((cl) => cl.id !== clientId));
      showToast('Client permanently deleted');
    } catch {
      showToast('Failed to delete \u2014 check your connection');
    }
  }, [showToast]);

  // ─── Task definition refresh (for editable checklists) ───
  const refreshClientTasks = useCallback(() => {
    saveClientPhaseTasks();
    setTasksVersion((v) => v + 1);
  }, []);

  // ─── Derived data (memoized) ───
  const activeClients = useMemo(
    () => clients.filter((cl) => !cl.archived && getClientPhase(cl) !== 'lost'),
    [clients, tasksVersion]
  );
  const archivedClients = useMemo(
    () => clients.filter((cl) => cl.archived),
    [clients, tasksVersion]
  );
  const wonClients = useMemo(
    () => clients.filter((cl) => getClientPhase(cl) === 'won' && !cl.archived),
    [clients, tasksVersion]
  );
  const lostClients = useMemo(
    () => clients.filter((cl) => getClientPhase(cl) === 'lost' && !cl.archived),
    [clients, tasksVersion]
  );

  return (
    <ClientContext.Provider value={{
      clients, loaded, tasksVersion,
      activeClients, archivedClients, wonClients, lostClients,
      filterPhase, setFilterPhase,
      addClient, updateClient, updatePhase, updateTask, updateTasksBulk,
      addNote, archiveClient, unarchiveClient, deleteClient, refreshClientTasks,
    }}>
      {children}
    </ClientContext.Provider>
  );
}

export function useClients() {
  const ctx = useContext(ClientContext);
  if (!ctx) throw new Error('useClients must be used within ClientProvider');
  return ctx;
}
