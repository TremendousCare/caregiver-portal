import { useState, useEffect, useCallback } from 'react';
import { AuthGate } from './components/AuthGate';
import { Sidebar } from './components/Sidebar';
import { Dashboard } from './components/Dashboard';
import { KanbanBoard } from './components/KanbanBoard';
import { AddCaregiver } from './components/AddCaregiver';
import { CaregiverDetail } from './components/CaregiverDetail';
import { Toast } from './components/Toast';
import { PHASES } from './lib/constants';
import { getCurrentPhase } from './lib/utils';
import { loadCaregivers, saveCaregivers, saveCaregiver, saveCaregiversBulk, loadPhaseTasks, savePhaseTasks, getPhaseTasks } from './lib/storage';
import { styles } from './styles/theme';

export default function App() {
  const [caregivers, setCaregivers] = useState([]);
  const [view, setView] = useState('dashboard'); // dashboard | detail | add | board
  const [selectedId, setSelectedId] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [showScripts, setShowScripts] = useState(null);
  const [filterPhase, setFilterPhase] = useState('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [showGreenLight, setShowGreenLight] = useState(false);
  const [toast, setToast] = useState(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [tasksVersion, setTasksVersion] = useState(0);
  const [currentUser, setCurrentUser] = useState(null);

  // ─── Load data on mount ───
  useEffect(() => {
    Promise.all([loadCaregivers(), loadPhaseTasks()]).then(([data]) => {
      setCaregivers(data);
      setTasksVersion((v) => v + 1);
      setLoaded(true);
    });
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
    setView('detail');
    setSelectedId(newCg.id);
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
    setView('dashboard');
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

  // ─── Derived data ───
  const selected = caregivers.find((c) => c.id === selectedId);

  // tasksVersion referenced so React re-computes when PHASE_TASKS loads
  const _tv = tasksVersion;
  const activeCaregivers = caregivers.filter((cg) => !cg.archived);
  const archivedCaregivers = caregivers.filter((cg) => cg.archived);
  const filtered = (filterPhase === 'archived' ? archivedCaregivers : activeCaregivers).filter((cg) => {
    const matchPhase = filterPhase === 'all' || filterPhase === 'archived' || getCurrentPhase(cg) === filterPhase;
    const matchSearch =
      !searchTerm ||
      `${cg.firstName} ${cg.lastName}`.toLowerCase().includes(searchTerm.toLowerCase()) ||
      cg.phone?.includes(searchTerm) ||
      cg.perId?.includes(searchTerm);
    return searchTerm ? matchSearch : matchPhase && matchSearch;
  });

  return (
    <AuthGate onUserReady={setCurrentUser}>
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
        />

        <main style={styles.main}>
          <div key={view} className="tc-page-enter">
            {view === 'dashboard' && (
              <Dashboard
                caregivers={filtered}
                allCaregivers={filterPhase === 'archived' ? archivedCaregivers : activeCaregivers}
                filterPhase={filterPhase}
                searchTerm={searchTerm}
                setSearchTerm={setSearchTerm}
                sidebarWidth={sidebarCollapsed ? 64 : 260}
                onSelect={(id) => {
                  setSelectedId(id);
                  setView('detail');
                }}
                onAdd={() => setView('add')}
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
              <AddCaregiver onAdd={addCaregiver} onCancel={() => setView('dashboard')} />
            )}
            {view === 'board' && (
              <KanbanBoard
                caregivers={activeCaregivers}
                onUpdateStatus={updateBoardStatus}
                onUpdateNote={updateBoardNote}
                onAddNote={addNote}
                onSelect={(id) => {
                  setSelectedId(id);
                  setView('detail');
                }}
              />
            )}
            {view === 'detail' && selected && (
              <CaregiverDetail
                caregiver={selected}
                allCaregivers={activeCaregivers}
                currentUser={currentUser}
                onBack={() => setView('dashboard')}
                onUpdateTask={updateTask}
                onUpdateTasksBulk={updateTasksBulk}
                onAddNote={addNote}
                onArchive={archiveCaregiver}
                onUnarchive={unarchiveCaregiver}
                onUpdateCaregiver={updateCaregiver}
                onRefreshTasks={refreshTasks}
                showScripts={showScripts}
                setShowScripts={setShowScripts}
                showGreenLight={showGreenLight}
                setShowGreenLight={setShowGreenLight}
              />
            )}
          </div>
        </main>
      </div>
    </AuthGate>
  );
}
