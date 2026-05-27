// Provider for follow-up tasks (migration 20260525000000) — exposes
// the live task list, a derived sidebar-badge count, and mutation
// helpers that update local state optimistically.
//
// Subscribes to follow_up_tasks via Supabase realtime so the dashboard
// reflects DB-generated instances (from the shifts trigger) and
// cross-tab updates the moment they happen.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { supabase, isSupabaseConfigured } from '../../lib/supabase';
import {
  dbToFollowUpTask,
  loadOpenFollowUps,
  markFollowUpDone,
  snoozeFollowUp,
  reassignFollowUp,
  cancelFollowUp,
  createUserTask,
  logTaskEvent,
  countNavBadge,
} from '../../lib/followUpTasks';
import { useApp } from './AppContext';

const FollowUpContext = createContext(null);

const RT_SUPPRESS_WINDOW = 3000;

export function FollowUpProvider({ children }) {
  const { currentUserName, currentUserEmail, showToast } = useApp();

  const [tasks, setTasks] = useState([]);
  const [loaded, setLoaded] = useState(false);
  // Suppress realtime echoes of mutations we just made locally — same
  // pattern as ClientContext to avoid jitter when our own UPDATE round-
  // trips back through the subscription.
  const recentLocalEdits = useRef(new Map());

  // ─── Composer (Quick Capture modal) state ─────────────────
  // Lives on the context so Cmd+K (AppShell) and the contextual
  // "+ Follow-up" buttons (entity panels) can open it with optional
  // prefills (caregiverId | clientId | lockEntity).
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerPrefill, setComposerPrefill] = useState(null);
  const openComposer = useCallback((prefill = null) => {
    setComposerPrefill(prefill);
    setComposerOpen(true);
  }, []);
  const closeComposer = useCallback(() => {
    setComposerOpen(false);
    setComposerPrefill(null);
  }, []);

  // ─── Initial load ─────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const list = await loadOpenFollowUps();
      if (cancelled) return;
      setTasks(list);
      setLoaded(true);
    };
    load();
    return () => { cancelled = true; };
  }, []);

  // ─── Realtime subscription ────────────────────────────────
  useEffect(() => {
    if (!isSupabaseConfigured()) return;

    const channel = supabase
      .channel('follow-up-tasks-changes')
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'follow_up_tasks' },
        (payload) => {
          const eventType = payload.eventType;
          if (eventType === 'INSERT') {
            const mapped = dbToFollowUpTask(payload.new);
            if (!mapped) return;
            setTasks((prev) => prev.some((t) => t.id === mapped.id) ? prev : [...prev, mapped]);
          } else if (eventType === 'UPDATE') {
            const mapped = dbToFollowUpTask(payload.new);
            if (!mapped) return;
            const editedAt = recentLocalEdits.current.get(mapped.id);
            if (editedAt && Date.now() - editedAt < RT_SUPPRESS_WINDOW) return;
            setTasks((prev) => {
              // Drop the task from the open list when it transitions
              // out of pending/snoozed.
              if (mapped.status === 'done' || mapped.status === 'cancelled') {
                return prev.filter((t) => t.id !== mapped.id);
              }
              const idx = prev.findIndex((t) => t.id === mapped.id);
              if (idx === -1) return [...prev, mapped];
              const copy = prev.slice();
              copy[idx] = mapped;
              return copy;
            });
          } else if (eventType === 'DELETE') {
            const oldId = payload.old?.id;
            if (!oldId) return;
            setTasks((prev) => prev.filter((t) => t.id !== oldId));
          }
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, []);

  // ─── Derived ──────────────────────────────────────────────
  const badgeCount = useMemo(() => countNavBadge(tasks), [tasks]);

  // ─── Mutations ────────────────────────────────────────────
  // Each mutation is optimistic: we patch local state immediately,
  // record the edit time so the realtime echo doesn't overwrite us,
  // then await the network. If the network fails we revert + toast.

  const noteLocalEdit = useCallback((id) => {
    recentLocalEdits.current.set(id, Date.now());
  }, []);

  const markDone = useCallback(async (taskId, note = null) => {
    const before = tasks.find((t) => t.id === taskId);
    if (!before) return;
    noteLocalEdit(taskId);
    setTasks((prev) => prev.filter((t) => t.id !== taskId));
    const { error } = await markFollowUpDone(taskId, { completedBy: currentUserName, note });
    if (error) {
      setTasks((prev) => prev.some((t) => t.id === taskId) ? prev : [...prev, before]);
      showToast?.('Could not mark done — please try again');
    }
  }, [tasks, currentUserName, noteLocalEdit, showToast]);

  const snooze = useCallback(async (taskId, until) => {
    const before = tasks.find((t) => t.id === taskId);
    if (!before) return;
    noteLocalEdit(taskId);
    setTasks((prev) => prev.map((t) => t.id === taskId
      ? { ...t, status: 'snoozed', snoozedUntil: until instanceof Date ? until.toISOString() : until }
      : t));
    const { error } = await snoozeFollowUp(taskId, until);
    if (error) {
      setTasks((prev) => prev.map((t) => t.id === taskId ? before : t));
      showToast?.('Could not snooze — please try again');
    }
  }, [tasks, noteLocalEdit, showToast]);

  const reassign = useCallback(async (taskId, assignee) => {
    const before = tasks.find((t) => t.id === taskId);
    if (!before) return;
    noteLocalEdit(taskId);
    setTasks((prev) => prev.map((t) => t.id === taskId
      ? { ...t, assignedTo: (assignee || '').trim() || null }
      : t));
    const { error } = await reassignFollowUp(taskId, assignee);
    if (error) {
      setTasks((prev) => prev.map((t) => t.id === taskId ? before : t));
      showToast?.('Could not reassign — please try again');
    }
  }, [tasks, noteLocalEdit, showToast]);

  const cancel = useCallback(async (taskId, reason) => {
    const before = tasks.find((t) => t.id === taskId);
    if (!before) return;
    noteLocalEdit(taskId);
    setTasks((prev) => prev.filter((t) => t.id !== taskId));
    const { error } = await cancelFollowUp(taskId, reason);
    if (error) {
      setTasks((prev) => prev.some((t) => t.id === taskId) ? prev : [...prev, before]);
      showToast?.('Could not cancel — please try again');
    }
  }, [tasks, noteLocalEdit, showToast]);

  // createTask: insert a new user-authored task. Returns { task, error }
  // — the modal awaits this to decide whether to close vs. show an error.
  // Optimistic update is by realtime INSERT echo (no local prepend) so
  // we don't double-add when the subscription fires.
  const createTask = useCallback(async (input) => {
    const { task, error } = await createUserTask({
      ...input,
      createdBy: input.createdBy || currentUserEmail || currentUserName || null,
    });
    if (!error && task) {
      // Fire-and-forget event log so the AI context layer picks it up.
      logTaskEvent('task_created', task, `user:${currentUserEmail || currentUserName || ''}`);
    }
    return { task, error };
  }, [currentUserEmail, currentUserName]);

  const value = useMemo(() => ({
    tasks, loaded, badgeCount,
    markDone, snooze, reassign, cancel, createTask,
    composerOpen, composerPrefill, openComposer, closeComposer,
  }), [tasks, loaded, badgeCount,
       markDone, snooze, reassign, cancel, createTask,
       composerOpen, composerPrefill, openComposer, closeComposer]);

  return (
    <FollowUpContext.Provider value={value}>
      {children}
    </FollowUpContext.Provider>
  );
}

export function useFollowUps() {
  const ctx = useContext(FollowUpContext);
  if (!ctx) {
    // Fail-safe shape so the Sidebar badge doesn't crash before the
    // provider mounts (e.g., during initial route transitions or in
    // route shells that don't wrap with FollowUpProvider).
    return {
      tasks: [], loaded: false, badgeCount: 0,
      markDone: async () => {}, snooze: async () => {},
      reassign: async () => {}, cancel: async () => {},
      createTask: async () => ({ task: null, error: new Error('Provider not mounted') }),
      composerOpen: false, composerPrefill: null,
      openComposer: () => {}, closeComposer: () => {},
    };
  }
  return ctx;
}
