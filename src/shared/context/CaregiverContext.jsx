import { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { getCurrentPhase } from '../../lib/utils';
import { loadCaregivers, saveCaregiver, saveCaregiversBulk, deleteCaregiversFromDb, loadPhaseTasks, savePhaseTasks, getPhaseTasks, dbToCaregiver } from '../../lib/storage';
import { supabase, isSupabaseConfigured } from '../../lib/supabase';
import { fireEventTriggers } from '../../lib/automations';
import { useApp } from './AppContext';

const CaregiverContext = createContext();

export function CaregiverProvider({ children }) {
  const { showToast, currentUserName } = useApp();

  const [caregivers, setCaregivers] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [tasksVersion, setTasksVersion] = useState(0);
  const [filterPhase, setFilterPhase] = useState('all');

  // ─── Load data on mount (with retry) ───
  useEffect(() => {
    let cancelled = false;
    const load = async (attempt = 1) => {
      try {
        const [data] = await Promise.all([loadCaregivers(), loadPhaseTasks()]);
        if (cancelled) return;
        setCaregivers(data);
        setTasksVersion((v) => v + 1);
        setLoaded(true);
        if (data.length === 0 && isSupabaseConfigured() && attempt === 1) {
          setTimeout(() => { if (!cancelled) load(2); }, 1500);
        }
      } catch (err) {
        console.error('Data load failed (attempt ' + attempt + '):', err);
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
      .channel('caregivers-changes')
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'caregivers' },
        (payload) => {
          const updatedRow = payload.new;
          if (!updatedRow?.id) return;
          const mapped = dbToCaregiver(updatedRow);
          setCaregivers((prev) =>
            prev.map((cg) => cg.id === mapped.id ? { ...cg, ...mapped } : cg)
          );
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, []);

  // ─── Caregiver CRUD ───
  const addCaregiver = useCallback((data) => {
    const newCg = {
      id: crypto.randomUUID(),
      ...data,
      tasks: {},
      notes: [],
      phaseTimestamps: { intake: Date.now() },
      createdAt: Date.now(),
    };
    setCaregivers((prev) => [newCg, ...prev]);
    saveCaregiver(newCg).catch(() => showToast('Failed to save — check your connection'));
    fireEventTriggers('new_caregiver', newCg);
    showToast(`${data.firstName} ${data.lastName} added successfully!`);
    return newCg;
  }, [showToast]);

  const updateTask = useCallback((cgId, taskId, value) => {
    const taskValue = value ? { completed: true, completedAt: Date.now(), completedBy: currentUserName } : false;
    let changed;
    let oldPhase;
    setCaregivers((prev) =>
      prev.map((cg) => {
        if (cg.id !== cgId) return cg;
        oldPhase = getCurrentPhase(cg);
        const updated = { ...cg, tasks: { ...cg.tasks, [taskId]: taskValue } };
        const newPhase = getCurrentPhase(updated);
        if (!updated.phaseTimestamps[newPhase]) {
          updated.phaseTimestamps = { ...updated.phaseTimestamps, [newPhase]: Date.now() };
        }
        changed = updated;
        return updated;
      })
    );
    if (changed) {
      saveCaregiver(changed).catch(() => showToast('Failed to save — check your connection'));
      if (value) {
        fireEventTriggers('task_completed', changed, { task_id: taskId });
      }
      const newPhase = getCurrentPhase(changed);
      if (oldPhase && newPhase !== oldPhase) {
        fireEventTriggers('phase_change', changed, { from_phase: oldPhase, to_phase: newPhase });
      }
    }
  }, [showToast, currentUserName]);

  const updateTasksBulk = useCallback((cgId, taskUpdates) => {
    const enriched = {};
    for (const [key, val] of Object.entries(taskUpdates)) {
      enriched[key] = val ? { completed: true, completedAt: Date.now(), completedBy: currentUserName } : false;
    }
    let changed;
    let oldPhase;
    setCaregivers((prev) =>
      prev.map((cg) => {
        if (cg.id !== cgId) return cg;
        oldPhase = getCurrentPhase(cg);
        const updated = { ...cg, tasks: { ...cg.tasks, ...enriched } };
        const newPhase = getCurrentPhase(updated);
        if (!updated.phaseTimestamps[newPhase]) {
          updated.phaseTimestamps = { ...updated.phaseTimestamps, [newPhase]: Date.now() };
        }
        changed = updated;
        return updated;
      })
    );
    if (changed) {
      saveCaregiver(changed).catch(() => showToast('Failed to save — check your connection'));
      for (const [key, val] of Object.entries(taskUpdates)) {
        if (val) fireEventTriggers('task_completed', changed, { task_id: key });
      }
      const newPhase = getCurrentPhase(changed);
      if (oldPhase && newPhase !== oldPhase) {
        fireEventTriggers('phase_change', changed, { from_phase: oldPhase, to_phase: newPhase });
      }
    }
  }, [showToast, currentUserName]);

  const addNote = useCallback((cgId, noteData) => {
    const note = typeof noteData === 'string'
      ? { text: noteData, timestamp: Date.now(), author: currentUserName }
      : { ...noteData, timestamp: Date.now(), author: noteData.author || currentUserName };
    let changed;
    setCaregivers((prev) =>
      prev.map((cg) => {
        if (cg.id !== cgId) return cg;
        changed = { ...cg, notes: [...(cg.notes || []), note] };
        return changed;
      })
    );
    if (changed) saveCaregiver(changed).catch(() => showToast('Failed to save — check your connection'));
  }, [showToast, currentUserName]);

  const archiveCaregiver = useCallback((cgId, reason, detail) => {
    let changed;
    setCaregivers((prev) =>
      prev.map((cg) => {
        if (cg.id !== cgId) return cg;
        changed = {
          ...cg,
          archived: true,
          archivedAt: Date.now(),
          archiveReason: reason,
          archiveDetail: detail || '',
          archivePhase: getCurrentPhase(cg),
          archivedBy: currentUserName,
        };
        return changed;
      })
    );
    if (changed) saveCaregiver(changed).catch(() => showToast('Failed to save — check your connection'));
    showToast('Caregiver archived');
  }, [showToast, currentUserName]);

  const unarchiveCaregiver = useCallback((cgId) => {
    let changed;
    setCaregivers((prev) =>
      prev.map((cg) => {
        if (cg.id !== cgId) return cg;
        changed = {
          ...cg,
          archived: false,
          archivedAt: null,
          archiveReason: null,
          archiveDetail: null,
          archivePhase: null,
        };
        return changed;
      })
    );
    if (changed) saveCaregiver(changed).catch(() => showToast('Failed to save — check your connection'));
    showToast('Caregiver restored to pipeline');
  }, [showToast]);

  const deleteCaregiver = useCallback(async (cgId) => {
    try {
      await deleteCaregiversFromDb([cgId]);
      setCaregivers((prev) => prev.filter((cg) => cg.id !== cgId));
      showToast('Caregiver permanently deleted');
    } catch {
      showToast('Failed to delete — check your connection');
    }
  }, [showToast]);

  const updateBoardStatus = useCallback((cgId, status) => {
    let changed;
    setCaregivers((prev) =>
      prev.map((cg) => {
        if (cg.id !== cgId) return cg;
        changed = { ...cg, boardStatus: status, boardMovedAt: Date.now() };
        return changed;
      })
    );
    if (changed) saveCaregiver(changed).catch(() => showToast('Failed to save — check your connection'));
  }, [showToast]);

  const updateBoardNote = useCallback((cgId, note) => {
    let changed;
    setCaregivers((prev) =>
      prev.map((cg) => {
        if (cg.id !== cgId) return cg;
        changed = { ...cg, boardNote: note };
        return changed;
      })
    );
    if (changed) saveCaregiver(changed).catch(() => showToast('Failed to save — check your connection'));
  }, [showToast]);

  const updateCaregiver = useCallback((cgId, updates) => {
    let changed;
    let oldPhase;
    setCaregivers((prev) =>
      prev.map((cg) => {
        if (cg.id !== cgId) return cg;
        oldPhase = getCurrentPhase(cg);
        changed = { ...cg, ...updates };
        return changed;
      })
    );
    if (changed) {
      saveCaregiver(changed).catch(() => showToast('Failed to save — check your connection'));
      const newPhase = getCurrentPhase(changed);
      if (oldPhase && newPhase !== oldPhase) {
        fireEventTriggers('phase_change', changed, { from_phase: oldPhase, to_phase: newPhase });
      }
    }
    showToast('Profile updated!');
  }, [showToast]);

  const refreshTasks = useCallback(() => {
    savePhaseTasks();
    setTasksVersion((v) => v + 1);
  }, []);

  const bulkPhaseOverride = useCallback((ids, phase) => {
    const changed = [];
    setCaregivers((prev) =>
      prev.map((cg) => {
        if (!ids.includes(cg.id)) return cg;
        const updated = {
          ...cg,
          phaseOverride: phase || null,
          phaseTimestamps: phase
            ? { ...cg.phaseTimestamps, [phase]: cg.phaseTimestamps?.[phase] || Date.now() }
            : cg.phaseTimestamps,
        };
        changed.push(updated);
        return updated;
      })
    );
    if (changed.length) saveCaregiversBulk(changed).catch(() => showToast('Failed to save — check your connection'));
  }, [showToast]);

  const bulkAddNote = useCallback((ids, text) => {
    const changed = [];
    setCaregivers((prev) =>
      prev.map((cg) => {
        if (!ids.includes(cg.id)) return cg;
        const updated = { ...cg, notes: [...(cg.notes || []), { text, timestamp: Date.now(), author: currentUserName, type: 'note' }] };
        changed.push(updated);
        return updated;
      })
    );
    if (changed.length) saveCaregiversBulk(changed).catch(() => showToast('Failed to save — check your connection'));
  }, [showToast, currentUserName]);

  const bulkBoardStatus = useCallback((ids, status) => {
    const changed = [];
    setCaregivers((prev) =>
      prev.map((cg) => {
        if (!ids.includes(cg.id)) return cg;
        const updated = { ...cg, boardStatus: status, boardMovedAt: Date.now() };
        changed.push(updated);
        return updated;
      })
    );
    if (changed.length) saveCaregiversBulk(changed).catch(() => showToast('Failed to save — check your connection'));
  }, [showToast]);

  const bulkArchive = useCallback((ids, reason) => {
    const changed = [];
    setCaregivers((prev) =>
      prev.map((cg) => {
        if (!ids.includes(cg.id)) return cg;
        const updated = {
          ...cg,
          archived: true,
          archivedAt: Date.now(),
          archiveReason: reason,
          archiveDetail: '',
          archivePhase: getCurrentPhase(cg),
          archivedBy: currentUserName,
        };
        changed.push(updated);
        return updated;
      })
    );
    if (changed.length) saveCaregiversBulk(changed).catch(() => showToast('Failed to save — check your connection'));
    showToast(`${ids.length} caregiver${ids.length !== 1 ? 's' : ''} archived`);
  }, [showToast, currentUserName]);

  const bulkSms = useCallback(async (ids, message) => {
    if (!supabase || !ids.length || !message.trim()) return { sent: 0, skipped: 0, failed: 0, results: [] };
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error('Not authenticated');
    const { data, error } = await supabase.functions.invoke('bulk-sms', {
      body: { caregiver_ids: ids, message, current_user: currentUserName },
    });
    if (error) throw error;
    return data;
  }, [currentUserName]);

  // ─── Derived data (memoized) ───
  const activeCaregivers = useMemo(() => caregivers.filter((cg) => !cg.archived), [caregivers, tasksVersion]);
  const archivedCaregivers = useMemo(() => caregivers.filter((cg) => cg.archived), [caregivers, tasksVersion]);

  return (
    <CaregiverContext.Provider value={{
      caregivers, loaded, tasksVersion,
      activeCaregivers, archivedCaregivers,
      filterPhase, setFilterPhase,
      addCaregiver, updateTask, updateTasksBulk, addNote,
      archiveCaregiver, unarchiveCaregiver, deleteCaregiver,
      updateBoardStatus, updateBoardNote, updateCaregiver,
      refreshTasks,
      bulkPhaseOverride, bulkAddNote, bulkBoardStatus, bulkArchive, bulkSms,
    }}>
      {children}
    </CaregiverContext.Provider>
  );
}

export function useCaregivers() {
  const ctx = useContext(CaregiverContext);
  if (!ctx) throw new Error('useCaregivers must be used within CaregiverProvider');
  return ctx;
}
