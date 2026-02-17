import { useState, useMemo } from 'react';
import { Routes, Route, useNavigate, useParams, Navigate } from 'react-router-dom';
import { useApp } from './shared/context/AppContext';
import { useCaregivers } from './shared/context/CaregiverContext';
import { CaregiverProvider } from './shared/context/CaregiverContext';
import { AuthGate } from './shared/components/AuthGate';
import { AIChatbot } from './shared/components/AIChatbot';
import { AppShell } from './shared/layout/AppShell';
import { ErrorBoundary } from './shared/components/ErrorBoundary';
import { Dashboard } from './features/caregivers/Dashboard';
import { KanbanBoard } from './features/caregivers/KanbanBoard';
import { AddCaregiver } from './features/caregivers/AddCaregiver';
import { CaregiverDetail } from './features/caregivers/CaregiverDetail';
import { AdminSettings } from './components/AdminSettings';
import { getCurrentPhase } from './lib/utils';
import btn from './styles/buttons.module.css';

// ─── Route Pages (bridge context → component props) ───

function DashboardPage() {
  const navigate = useNavigate();
  const { sidebarCollapsed } = useApp();
  const {
    activeCaregivers, archivedCaregivers, filterPhase, tasksVersion,
    bulkPhaseOverride, bulkAddNote, bulkBoardStatus, bulkArchive,
  } = useCaregivers();
  const [searchTerm, setSearchTerm] = useState('');

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
    <Dashboard
      caregivers={filtered}
      allCaregivers={filterPhase === 'archived' ? archivedCaregivers : activeCaregivers}
      filterPhase={filterPhase}
      searchTerm={searchTerm}
      setSearchTerm={setSearchTerm}
      sidebarWidth={sidebarCollapsed ? 64 : 260}
      onSelect={(id) => navigate(`/caregiver/${id}`)}
      onAdd={() => navigate('/add')}
      onBulkPhaseOverride={bulkPhaseOverride}
      onBulkAddNote={bulkAddNote}
      onBulkBoardStatus={bulkBoardStatus}
      onBulkArchive={bulkArchive}
    />
  );
}

function BoardPage() {
  const navigate = useNavigate();
  const { activeCaregivers, updateBoardStatus, updateBoardNote, addNote } = useCaregivers();

  return (
    <KanbanBoard
      caregivers={activeCaregivers}
      onUpdateStatus={updateBoardStatus}
      onUpdateNote={updateBoardNote}
      onAddNote={addNote}
      onSelect={(id) => navigate(`/caregiver/${id}`)}
    />
  );
}

function AddCaregiverPage() {
  const navigate = useNavigate();
  const { addCaregiver } = useCaregivers();

  return (
    <AddCaregiver
      onAdd={(data) => {
        const newCg = addCaregiver(data);
        navigate(`/caregiver/${newCg.id}`);
      }}
      onCancel={() => navigate('/')}
    />
  );
}

function CaregiverDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { showToast, currentUserName, currentUserEmail } = useApp();
  const {
    caregivers, activeCaregivers,
    updateTask, updateTasksBulk, addNote,
    archiveCaregiver, unarchiveCaregiver, deleteCaregiver,
    updateCaregiver, refreshTasks,
  } = useCaregivers();

  const [showScripts, setShowScripts] = useState(null);
  const [showGreenLight, setShowGreenLight] = useState(false);

  const caregiver = useMemo(() => caregivers.find((c) => c.id === id), [caregivers, id]);

  if (!caregiver) {
    return (
      <div style={{ textAlign: 'center', padding: '80px 24px', color: '#7A8BA0' }}>
        <h2 style={{ color: '#0F1724', marginBottom: 8 }}>Caregiver not found</h2>
        <button className={btn.secondaryBtn} style={{ marginTop: 16 }} onClick={() => navigate('/')}>
          Back to Dashboard
        </button>
      </div>
    );
  }

  return (
    <CaregiverDetail
      caregiver={caregiver}
      allCaregivers={activeCaregivers}
      currentUser={{ displayName: currentUserName, email: currentUserEmail }}
      onBack={() => navigate('/')}
      onUpdateTask={updateTask}
      onUpdateTasksBulk={updateTasksBulk}
      onAddNote={addNote}
      onArchive={(cgId, reason, detail) => {
        archiveCaregiver(cgId, reason, detail);
        navigate('/');
      }}
      onUnarchive={unarchiveCaregiver}
      onDelete={(cgId) => {
        deleteCaregiver(cgId);
        navigate('/');
      }}
      onUpdateCaregiver={updateCaregiver}
      onRefreshTasks={refreshTasks}
      showScripts={showScripts}
      setShowScripts={setShowScripts}
      showGreenLight={showGreenLight}
      setShowGreenLight={setShowGreenLight}
      showToast={showToast}
    />
  );
}

function SettingsPage() {
  const navigate = useNavigate();
  const { showToast, currentUserEmail, isAdmin } = useApp();

  if (!isAdmin) {
    return (
      <div style={{ textAlign: 'center', padding: '80px 24px', color: '#7A8BA0' }}>
        <h2 style={{ color: '#0F1724', marginBottom: 8 }}>Access Denied</h2>
        <p>You need admin privileges to view Settings.</p>
        <button className={btn.secondaryBtn} style={{ marginTop: 16 }} onClick={() => navigate('/')}>
          Back to Dashboard
        </button>
      </div>
    );
  }

  return <AdminSettings showToast={showToast} currentUserEmail={currentUserEmail} />;
}

// ─── App (thin shell: auth + providers + routes) ───

export default function App() {
  const { handleUserReady, handleLogout, currentUserName } = useApp();

  return (
    <AuthGate onUserReady={handleUserReady} onLogout={handleLogout}>
      <CaregiverProvider>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<DashboardPage />} />
            <Route path="board" element={<BoardPage />} />
            <Route path="add" element={<AddCaregiverPage />} />
            <Route path="caregiver/:id" element={<CaregiverDetailPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
        <AIChatbot caregiverId={null} currentUser={currentUserName} />
      </CaregiverProvider>
    </AuthGate>
  );
}
