import { useState, useEffect, useCallback, useMemo } from 'react';
import { Routes, Route, useNavigate, useLocation, useParams, Navigate } from 'react-router-dom';
import { AuthGate } from './components/AuthGate';
import { Sidebar } from './components/Sidebar';
import { Dashboard } from './components/Dashboard';
import { KanbanBoard } from './components/KanbanBoard';
import { AddCaregiver } from './components/AddCaregiver';
import { CaregiverDetail } from './components/CaregiverDetail';
import { AdminSettings } from './components/AdminSettings';
import { Toast } from './components/Toast';
import { AIChatbot } from './components/AIChatbot';
import { PHASES } from './lib/constants';
import { getCurrentPhase } from './lib/utils';
import { loadCaregivers, saveCaregivers, saveCaregiver, saveCaregiversBulk, deleteCaregiversFromDb, loadPhaseTasks, savePhaseTasks, getPhaseTasks } from './lib/storage';
import { supabase, isSupabaseConfigured } from './lib/supabase';
import { styles } from './styles/theme';

// ─── Route-to-view mapping ───
const VIEW_ROUTES = { dashboard: '/', board: '/board', add: '/add', detail: '/caregiver', settings: '/settings' };
const ROUTE_VIEWS = { '/': 'dashboard', '/board': 'board', '/add': 'add', '/settings': 'settings' };

export default function App() {
  const navigate = useNavigate();
  const location = useLocation();
  // ─── Derive view + selectedId from URL ───
  const pathParts = location.pathname.split('/').filter(Boolean);
  const view = pathParts[0] === 'caregiver' ? 'detail' : (ROUTE_VIEWS[location.pathname] || 'dashboard');
  const selectedId = pathParts[0] === 'caregiver' ? pathParts[1] || null : null;

  const setView = useCallback((v) => {
    if (v === 'dashboard') navigate('/');
    else if (v === 'board') navigate('/board');
    else if (v === 'add') navigate('/add');
    else if (v === 'settings') navigate('/settings');
  }, [navigate]);

  const selectCaregiver = useCallback((id) => {
    navigate(`/caregiver/${id}`);
  }, [navigate]);

  const [caregivers, setCaregivers] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [showScripts, setShowScripts] = useState(null);
  const [filterPhase, setFilterPhase] = useState('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [showGreenLight, setShowGreenLight] = useState(false);
  const [toast, setToast] = useState(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [tasksVersion, setTasksVersion] = useState(0);
  const [currentUser, setCurrentUser] = useState(null);

  // ─── Logout handler ───
  const handleLogout = useCallback(async () => {
    if (isSupabaseConfigured()) {
      await supabase.auth.signOut();
    } else {
      // Legacy mode: clear localStorage auth
      localStorage.removeItem('tc-auth-v1');
      localStorage.removeItem('tc-user-name-v1');
    }
    setCurrentUser(null);
    window.location.reload();
  }, []);

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
        // If we got 0 results and Supabase is configured, retry once (may be a cold-start)
        if (data.length === 0 && isSupabaseConfigured() && attempt === 1) {
          setTimeout(() => { if (!cancelled) load(2); }, 1500);
        }
      } catch (err) {
        console.error('Data load failed (attempt ' + attempt + '):', err);
        if (attempt < 3 && !cancelled) {
          setTimeout(() => load(attempt + 1), 1000 * attempt);
        } else if (!cancelled) {
          setLoaded(true); // show UI even if load fails
        }
      }
    };
    load();
    return () => { cancelled = true; };
  }, []);

  // ─── Toast auto-dismiss ───
  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(null), 3000);
      return () => clearTimeout(t);
    }
  }, [toast]);

  const showToast = (msg) => setToast(msg);

  // ─── Caregiver CRUD ───
  const addCaregiver = (data) => {
    const newCg = {
      id: crypto.randomUUID(),
      ...data,
      tasks: {},
      notes: [],
      phaseTimestamps: { intake: Date.now() },
      createdAt: Date.now(),
    };
    setCaregivers((prev) => [newCg, ...prev]);
    navigate(`/caregiver/${newCg.id}`);
    saveCaregiver(newCg).catch(() => showToast('Failed to save — check your connection'));
    showToast(`${data.firstName} ${data.lastName} added successfully!`);
  };

  const updateTask = (cgId, taskId, value) => {
    const taskValue = value ? { completed: true, completedAt: Date.now(), completedBy: currentUser || '' } : false;
    let changed;
    setCaregivers((prev) =>
      prev.map((cg) => {
        if (cg.id !== cgId) return cg;
        const updated = { ...cg, tasks: { ...cg.tasks, [taskId]: taskValue } };
        const newPhase = getCurrentPhase(updated);
        if (!updated.phaseTimestamps[newPhase]) {
          updated.phaseTimestamps = { ...updated.phaseTimestamps, [newPhase]: Date.now() };
        }
        changed = updated;
        return updated;
      })
    );
    if (changed) saveCaregiver(changed).catch(() => showToast('Failed to save — check your connection'));
  };

  const updateTasksBulk = (cgId, taskUpdates) => {
    const enriched = {};
    for (const [key, val] of Object.entries(taskUpdates)) {
      enriched[key] = val ? { completed: true, completedAt: Date.now(), completedBy: currentUser || '' } : false;
    }
    let changed;
    setCaregivers((prev) =>
      prev.map((cg) => {
        if (cg.id !== cgId) return cg;
        const updated = { ...cg, tasks: { ...cg.tasks, ...enriched } };
        const newPhase = getCurrentPhase(updated);
        if (!updated.phaseTimestamps[newPhase]) {
          updated.phaseTimestamps = { ...updated.phaseTimestamps, [newPhase]: Date.now() };
        }
        changed = updated;
        return updated;
      })
    );
    if (changed) saveCaregiver(changed).catch(() => showToast('Failed to save — check your connection'));
  };

  const addNote = (cgId, noteData) => {
    // noteData can be a string (legacy) or an object with structured fields
    const note = typeof noteData === 'string'
      ? { text: noteData, timestamp: Date.now(), author: currentUser || '' }
      : { ...noteData, timestamp: Date.now(), author: noteData.author || currentUser || '' };
    let changed;
    setCaregivers((prev) =>
      prev.map((cg) => {
        if (cg.id !== cgId) return cg;
        changed = { ...cg, notes: [...(cg.notes || []), note] };
        return changed;
      })
    );
    if (changed) saveCaregiver(changed).catch(() => showToast('Failed to save — check your connection'));
  };

  const archiveCaregiver = (cgId, reason, detail) => {
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
          archivedBy: currentUser || '',
        };
        return changed;
      })
    );
    if (changed) saveCaregiver(changed).catch(() => showToast('Failed to save — check your connection'));
    navigate('/');
    showToast('Caregiver archived');
  };

  const unarchiveCaregiver = (cgId) => {
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
  };

  const deleteCaregiver = async (cgId) => {
    try {
      await deleteCaregiversFromDb([cgId]);
      setCaregivers((prev) => prev.filter((cg) => cg.id !== cgId));
      navigate('/');
      showToast('Caregiver permanently deleted');
    } catch {
      showToast('Failed to delete — check your connection');
    }
  };

  const updateBoardStatus = (cgId, status) => {
    let changed;
    setCaregivers((prev) =>
      prev.map((cg) => {
        if (cg.id !== cgId) return cg;
        changed = { ...cg, boardStatus: status, boardMovedAt: Date.now() };
        return changed;
      })
    );
    if (changed) saveCaregiver(changed).catch(() => showToast('Failed to save — check your connection'));
  };

  const updateBoardNote = (cgId, note) => {
    let changed;
    setCaregivers((prev) =>
      prev.map((cg) => {
        if (cg.id !== cgId) return cg;
        changed = { ...cg, boardNote: note };
        return changed;
      })
    );
    if (changed) saveCaregiver(changed).catch(() => showToast('Failed to save — check your connection'));
  };

  const updateCaregiver = (cgId, updates) => {
    let changed;
    setCaregivers((prev) =>
      prev.map((cg) => {
        if (cg.id !== cgId) return cg;
        changed = { ...cg, ...updates };
        return changed;
      })
    );
    if (changed) saveCaregiver(changed).catch(() => showToast('Failed to save — check your connection'));
    showToast('Profile updated!');
  };

  const refreshTasks = () => {
    savePhaseTasks();
    setTasksVersion((v) => v + 1);
  };

  // ─── Derived data (memoized) ───
  const selected = useMemo(() => caregivers.find((c) => c.id === selectedId), [caregivers, selectedId]);

  // tasksVersion referenced so React re-computes when PHASE_TASKS loads
  const activeCaregivers = useMemo(() => caregivers.filter((cg) => !cg.archived), [caregivers, tasksVersion]);
  const archivedCaregivers = useMemo(() => caregivers.filter((cg) => cg.archived), [caregivers, tasksVersion]);
  const filtered = useMemo(() => {
    const base = filterPhase === 'archived' ? archivedCaregivers : activeCaregivers;
    return base.filter((cg) => {
      const matchPhase = filterPhase === 'all' || filterPhase === 'archived' || getCurrentPhase(cg) === filterPhase;
      const matchSearch =
        !searchTerm ||
        `${cg.firstName} ${cg.lastName}`.toLowerCase().includes(searchTerm.toLowerCase()) ||
        cg.phone?.includes(searchTerm) ||
        cg.perId?.includes(searchTerm);
      return searchTerm ? matchSearch : matchPhase && matchSearch;
    });
  }, [activeCaregivers, archivedCaregivers, filterPhase, searchTerm, tasksVersion]);

  return (
    <AuthGate onUserReady={setCurrentUser} onLogout={handleLogout}>
      <div style={styles.app}>
        <Toast message={toast} />

        <Sidebar
          view={view}
          setView={setView}
          filterPhase={filterPhase}
          setFilterPhase={setFilterPhase}
          caregivers={activeCaregivers}
          archivedCount={archivedCaregivers.length}
          collapsed={sidebarCollapsed}
          setCollapsed={setSidebarCollapsed}
          currentUser={currentUser}
          onLogout={handleLogout}
        />

        <main style={styles.main}>
          {!loaded && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh', color: '#7A8BA0', fontSize: 15 }}>
              Loading caregivers...
            </div>
          )}
          {loaded && <div key={view} className="tc-page-enter">
            {view === 'dashboard' && (
              <Dashboard
                caregivers={filtered}
                allCaregivers={filterPhase === 'archived' ? archivedCaregivers : activeCaregivers}
                filterPhase={filterPhase}
                searchTerm={searchTerm}
                setSearchTerm={setSearchTerm}
                sidebarWidth={sidebarCollapsed ? 64 : 260}
                onSelect={(id) => selectCaregiver(id)}
                onAdd={() => navigate('/add')}
                onBulkPhaseOverride={(ids, phase) => {
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
                }}
                onBulkAddNote={(ids, text) => {
                  const changed = [];
                  setCaregivers((prev) =>
                    prev.map((cg) => {
                      if (!ids.includes(cg.id)) return cg;
                      const updated = { ...cg, notes: [...(cg.notes || []), { text, timestamp: Date.now(), author: currentUser || '', type: 'note' }] };
                      changed.push(updated);
                      return updated;
                    })
                  );
                  if (changed.length) saveCaregiversBulk(changed).catch(() => showToast('Failed to save — check your connection'));
                }}
                onBulkBoardStatus={(ids, status) => {
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
                }}
                onBulkArchive={(ids, reason) => {
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
                        archivedBy: currentUser || '',
                      };
                      changed.push(updated);
                      return updated;
                    })
                  );
                  if (changed.length) saveCaregiversBulk(changed).catch(() => showToast('Failed to save — check your connection'));
                  showToast(`${ids.length} caregiver${ids.length !== 1 ? 's' : ''} archived`);
                }}
              />
            )}
            {view === 'add' && (
              <AddCaregiver onAdd={addCaregiver} onCancel={() => navigate('/')} />
            )}
            {view === 'board' && (
              <KanbanBoard
                caregivers={activeCaregivers}
                onUpdateStatus={updateBoardStatus}
                onUpdateNote={updateBoardNote}
                onAddNote={addNote}
                onSelect={(id) => selectCaregiver(id)}
              />
            )}
            {view === 'settings' && (
              <AdminSettings showToast={showToast} />
            )}
            {view === 'detail' && selected && (
              <CaregiverDetail
                caregiver={selected}
                allCaregivers={activeCaregivers}
                currentUser={currentUser}
                onBack={() => navigate('/')}
                onUpdateTask={updateTask}
                onUpdateTasksBulk={updateTasksBulk}
                onAddNote={addNote}
                onArchive={archiveCaregiver}
                onUnarchive={unarchiveCaregiver}
                onDelete={deleteCaregiver}
                onUpdateCaregiver={updateCaregiver}
                onRefreshTasks={refreshTasks}
                showScripts={showScripts}
                setShowScripts={setShowScripts}
                showGreenLight={showGreenLight}
                setShowGreenLight={setShowGreenLight}
              />
            )}
          </div>}
        </main>
      </div>
      <AIChatbot caregiverId={selectedId} currentUser={currentUser} />
    </AuthGate>
  );
}
