import { useState, useMemo } from 'react';
import { Routes, Route, useNavigate, useParams, Navigate } from 'react-router-dom';
import { useApp } from './shared/context/AppContext';
import { useCaregivers } from './shared/context/CaregiverContext';
import { CaregiverProvider } from './shared/context/CaregiverContext';
import { useClients } from './shared/context/ClientContext';
import { ClientProvider } from './shared/context/ClientContext';
import { AuthGate } from './shared/components/AuthGate';
import { AIChatbot } from './shared/components/AIChatbot';
import { AppShell } from './shared/layout/AppShell';
import { ErrorBoundary } from './shared/components/ErrorBoundary';
import { Dashboard } from './features/caregivers/Dashboard';
import { KanbanBoard } from './features/caregivers/KanbanBoard';
import { AddCaregiver } from './features/caregivers/AddCaregiver';
import { CaregiverDetail } from './features/caregivers/CaregiverDetail';
import { ClientDashboard } from './features/clients/ClientDashboard';
import { AddClient } from './features/clients/AddClient';
import { ClientDetail } from './features/clients/ClientDetail';
import { SequenceSettings } from './features/clients/SequenceSettings';
import { AdminSettings } from './components/AdminSettings';
import { getCurrentPhase } from './lib/utils';
import { getClientPhase } from './features/clients/utils';
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

// ─── Client Route Pages (bridge context → component props) ───

function ClientDashboardPage() {
  const navigate = useNavigate();
  const { sidebarCollapsed } = useApp();
  const { activeClients, archivedClients, filterPhase, tasksVersion } = useClients();
  const [searchTerm, setSearchTerm] = useState('');

  const filtered = useMemo(() => {
    const base = filterPhase === 'archived' ? archivedClients : activeClients;
    return base.filter((cl) => {
      const matchPhase = filterPhase === 'all' || filterPhase === 'archived' || getClientPhase(cl) === filterPhase;
      const matchSearch =
        !searchTerm ||
        `${cl.firstName} ${cl.lastName}`.toLowerCase().includes(searchTerm.toLowerCase()) ||
        cl.phone?.includes(searchTerm) ||
        cl.email?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        cl.careRecipientName?.toLowerCase().includes(searchTerm.toLowerCase());
      return searchTerm ? matchSearch : matchPhase && matchSearch;
    });
  }, [activeClients, archivedClients, filterPhase, searchTerm, tasksVersion]);

  return (
    <ClientDashboard
      clients={filtered}
      allClients={filterPhase === 'archived' ? archivedClients : activeClients}
      filterPhase={filterPhase}
      searchTerm={searchTerm}
      setSearchTerm={setSearchTerm}
      sidebarWidth={sidebarCollapsed ? 64 : 260}
      onSelect={(id) => navigate(`/clients/${id}`)}
      onAdd={() => navigate('/clients/add')}
    />
  );
}

function AddClientPage() {
  const navigate = useNavigate();
  const { addClient } = useClients();

  return (
    <AddClient
      onAdd={(data) => {
        const newCl = addClient(data);
        navigate(`/clients/${newCl.id}`);
      }}
      onCancel={() => navigate('/clients')}
    />
  );
}

function ClientDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { showToast, currentUserName, currentUserEmail } = useApp();
  const {
    clients, activeClients,
    updateTask, updateTasksBulk, addNote, updatePhase,
    archiveClient, unarchiveClient, deleteClient, updateClient,
  } = useClients();

  const client = useMemo(() => clients.find((c) => c.id === id), [clients, id]);

  if (!client) {
    return (
      <div style={{ textAlign: 'center', padding: '80px 24px', color: '#7A8BA0' }}>
        <h2 style={{ color: '#0F1724', marginBottom: 8 }}>Client not found</h2>
        <button className={btn.secondaryBtn} style={{ marginTop: 16 }} onClick={() => navigate('/clients')}>
          Back to Clients
        </button>
      </div>
    );
  }

  return (
    <ClientDetail
      client={client}
      allClients={activeClients}
      currentUser={{ displayName: currentUserName, email: currentUserEmail }}
      onBack={() => navigate('/clients')}
      onUpdateTask={updateTask}
      onUpdateTasksBulk={updateTasksBulk}
      onAddNote={addNote}
      onUpdatePhase={updatePhase}
      onArchive={(clId, reason, detail) => {
        archiveClient(clId, reason, detail);
        navigate('/clients');
      }}
      onUnarchive={unarchiveClient}
      onDelete={(clId) => {
        deleteClient(clId);
        navigate('/clients');
      }}
      onUpdateClient={updateClient}
      showToast={showToast}
    />
  );
}

function SequenceSettingsPage() {
  const { showToast, currentUserEmail } = useApp();
  return <SequenceSettings showToast={showToast} currentUserEmail={currentUserEmail} />;
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
        <ClientProvider>
          <Routes>
            <Route element={<AppShell />}>
              <Route index element={<DashboardPage />} />
              <Route path="board" element={<BoardPage />} />
              <Route path="add" element={<AddCaregiverPage />} />
              <Route path="caregiver/:id" element={<CaregiverDetailPage />} />
              <Route path="clients" element={<ClientDashboardPage />} />
              <Route path="clients/add" element={<AddClientPage />} />
              <Route path="clients/sequences" element={<SequenceSettingsPage />} />
              <Route path="clients/:id" element={<ClientDetailPage />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
          <AIChatbot caregiverId={null} currentUser={currentUserName} />
        </ClientProvider>
      </CaregiverProvider>
    </AuthGate>
  );
}
