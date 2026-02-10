import { useState, useEffect, useCallback } from 'react';
import { AuthGate } from './components/AuthGate';
import { Sidebar } from './components/Sidebar';
import { Dashboard } from './components/Dashboard';
import { KanbanBoard } from './components/KanbanBoard';
import { AddCaregiver } from './components/AddCaregiver';
import { CaregiverDetail } from './components/CaregiverDetail';
import { Toast } from './components/Toast';
import { ChatWidget } from './components/ChatWidget';
import { PHASES } from './lib/constants';
import { getCurrentPhase } from './lib/utils';
import { loadCaregivers, saveCaregivers, loadPhaseTasks, savePhaseTasks, getPhaseTasks } from './lib/storage';
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

  // ─── Auto-save caregivers ───
  useEffect(() => {
    if (loaded) saveCaregivers(caregivers);
  }, [caregivers, loaded]);

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
      id: Date.now().toString(),
      ...data,
      tasks: {},
      notes: [],
      phaseTimestamps: { intake: Date.now() },
      createdAt: Date.now(),
    };
    setCaregivers((prev) => [newCg, ...prev]);
    setView('detail');
    setSelectedId(newCg.id);
    showToast(`${data.firstName} ${data.lastName} added successfully!`);
  };

  const updateTask = (cgId, taskId, value) => {
    const taskValue = value ? { completed: true, completedAt: Date.now(), completedBy: currentUser || '' } : false;
    setCaregivers((prev) =>
      prev.map((cg) => {
        if (cg.id !== cgId) return cg;
        const updated = { ...cg, tasks: { ...cg.tasks, [taskId]: taskValue } };
        const newPhase = getCurrentPhase(updated);
        if (!updated.phaseTimestamps[newPhase]) {
          updated.phaseTimestamps = { ...updated.phaseTimestamps, [newPhase]: Date.now() };
        }
        return updated;
      })
    );
  };

  const updateTasksBulk = (cgId, taskUpdates) => {
    const enriched = {};
    for (const [key, val] of Object.entries(taskUpdates)) {
      enriched[key] = val ? { completed: true, completedAt: Date.now(), completedBy: currentUser || '' } : false;
    }
    setCaregivers((prev) =>
      prev.map((cg) => {
        if (cg.id !== cgId) return cg;
        const updated = { ...cg, tasks: { ...cg.tasks, ...enriched } };
        const newPhase = getCurrentPhase(updated);
        if (!updated.phaseTimestamps[newPhase]) {
          updated.phaseTimestamps = { ...updated.phaseTimestamps, [newPhase]: Date.now() };
        }
        return updated;
      })
    );
  };

  const addNote = (cgId, noteData) => {
    // noteData can be a string (legacy) or an object with structured fields
    const note = typeof noteData === 'string'
      ? { text: noteData, timestamp: Date.now(), author: currentUser || '' }
      : { ...noteData, timestamp: Date.now(), author: noteData.author || currentUser || '' };
    setCaregivers((prev) =>
      prev.map((cg) =>
        cg.id === cgId
          ? { ...cg, notes: [...(cg.notes || []), note] }
          : cg
      )
    );
  };

  const archiveCaregiver = (cgId, reason, detail) => {
    setCaregivers((prev) =>
      prev.map((cg) => {
        if (cg.id !== cgId) return cg;
        return {
          ...cg,
          archived: true,
          archivedAt: Date.now(),
          archiveReason: reason,
          archiveDetail: detail || '',
          archivePhase: getCurrentPhase(cg),
          archivedBy: currentUser || '',
        };
      })
    );
    setView('dashboard');
    showToast('Caregiver archived');
  };

  const unarchiveCaregiver = (cgId) => {
    setCaregivers((prev) =>
      prev.map((cg) => {
        if (cg.id !== cgId) return cg;
        return {
          ...cg,
          archived: false,
          archivedAt: null,
          archiveReason: null,
          archiveDetail: null,
          archivePhase: null,
        };
      })
    );
    showToast('Caregiver restored to pipeline');
  };

  const updateBoardStatus = (cgId, status) => {
    setCaregivers((prev) =>
      prev.map((cg) =>
        cg.id === cgId ? { ...cg, boardStatus: status, boardMovedAt: Date.now() } : cg
      )
    );
  };

  const updateBoardNote = (cgId, note) => {
    setCaregivers((prev) =>
      prev.map((cg) => (cg.id === cgId ? { ...cg, boardNote: note } : cg))
    );
  };

  const updateCaregiver = (cgId, updates) => {
    setCaregivers((prev) =>
      prev.map((cg) => (cg.id === cgId ? { ...cg, ...updates } : cg))
    );
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
                  setCaregivers((prev) =>
                    prev.map((cg) => {
                      if (!ids.includes(cg.id)) return cg;
                      return {
                        ...cg,
                        phaseOverride: phase || null,
                        phaseTimestamps: phase
                          ? { ...cg.phaseTimestamps, [phase]: cg.phaseTimestamps?.[phase] || Date.now() }
                          : cg.phaseTimestamps,
                      };
                    })
                  );
                }}
                onBulkAddNote={(ids, text) => {
                  setCaregivers((prev) =>
                    prev.map((cg) =>
                      ids.includes(cg.id)
                        ? { ...cg, notes: [...(cg.notes || []), { text, timestamp: Date.now(), author: currentUser || '', type: 'note' }] }
                        : cg
                    )
                  );
                }}
                onBulkBoardStatus={(ids, status) => {
                  setCaregivers((prev) =>
                    prev.map((cg) =>
                      ids.includes(cg.id)
                        ? { ...cg, boardStatus: status, boardMovedAt: Date.now() }
                        : cg
                    )
                  );
                }}
                onBulkArchive={(ids, reason) => {
                  setCaregivers((prev) =>
                    prev.map((cg) => {
                      if (!ids.includes(cg.id)) return cg;
                      return {
                        ...cg,
                        archived: true,
                        archivedAt: Date.now(),
                        archiveReason: reason,
                        archiveDetail: '',
                        archivePhase: getCurrentPhase(cg),
                        archivedBy: currentUser || '',
                      };
                    })
                  );
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

        <ChatWidget
          caregivers={caregivers}
          selectedCaregiver={view === 'detail' ? selected : null}
        />
      </div>
    </AuthGate>
  );
}
