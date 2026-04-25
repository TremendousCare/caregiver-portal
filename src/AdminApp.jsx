// Admin portal — loaded lazily from App.jsx so the caregiver PWA and
// other public routes don't pull the admin bundle. See App.jsx for the
// top-level route split.

import { useState, useMemo, useEffect, useCallback } from 'react';
import { Routes, Route, useNavigate, useParams, Navigate } from 'react-router-dom';
import { useApp } from './shared/context/AppContext';
import { useCaregivers, CaregiverProvider } from './shared/context/CaregiverContext';
import { useClients, ClientProvider } from './shared/context/ClientContext';
import { BoardProvider, useBoards } from './shared/context/BoardContext';
import { AuthGate } from './shared/components/AuthGate';
import { AIChatbot } from './shared/components/AIChatbot';
import { AppShell } from './shared/layout/AppShell';
import { Dashboard } from './features/caregivers/Dashboard';
import { KanbanBoard } from './features/caregivers/KanbanBoard';
import { AddCaregiver } from './features/caregivers/AddCaregiver';
import { CaregiverDetail } from './features/caregivers/CaregiverDetail';
import { ActiveRoster } from './features/caregivers/ActiveRoster';
import { BoardsIndex } from './features/boards/BoardsIndex';
import { ClientDashboard } from './features/clients/ClientDashboard';
import { AddClient } from './features/clients/AddClient';
import { ClientDetail } from './features/clients/ClientDetail';
import { SequenceSettings } from './features/clients/SequenceSettings';
import { SchedulePage } from './features/scheduling/SchedulePage';
import { AdminSettings } from './components/AdminSettings';
import { IndeedImportModal } from './features/caregivers/IndeedImport';
import { getCurrentPhase, getOverallProgress, isAwaitingInterviewResponse } from './lib/utils';
import { getClientPhase } from './features/clients/utils';
import btn from './styles/buttons.module.css';

// ─── Route Pages (bridge context → component props) ───

function DashboardPage() {
  const navigate = useNavigate();
  const { sidebarCollapsed, showToast } = useApp();
  const {
    activeCaregivers, archivedCaregivers, onboardingCaregivers, filterPhase, tasksVersion,
    addCaregiver, addNote,
    bulkPhaseOverride, bulkAddNote, bulkBoardStatus, bulkArchive, bulkSms,
  } = useCaregivers();
  const [searchTerm, setSearchTerm] = useState('');
  const [showIndeedImport, setShowIndeedImport] = useState(false);

  const filtered = useMemo(() => {
    const base = filterPhase === 'archived' ? archivedCaregivers : onboardingCaregivers;
    return base.filter((cg) => {
      const matchPhase =
        filterPhase === 'all' ||
        filterPhase === 'archived' ||
        (filterPhase === 'intake_pending'
          ? getCurrentPhase(cg) === 'intake' && isAwaitingInterviewResponse(cg)
          : filterPhase === 'intake'
          ? getCurrentPhase(cg) === 'intake' && !isAwaitingInterviewResponse(cg)
          : getCurrentPhase(cg) === filterPhase);
      const matchSearch =
        !searchTerm ||
        `${cg.firstName} ${cg.lastName}`.toLowerCase().includes(searchTerm.toLowerCase()) ||
        cg.phone?.includes(searchTerm) ||
        cg.perId?.includes(searchTerm);
      return searchTerm ? matchSearch : matchPhase && matchSearch;
    });
  }, [onboardingCaregivers, archivedCaregivers, filterPhase, searchTerm, tasksVersion]);

  const allCaregivers = filterPhase === 'archived' ? archivedCaregivers : onboardingCaregivers;

  const handleImportCaregiver = useCallback((caregiverData, note) => {
    const newCg = addCaregiver(caregiverData);
    if (newCg && note) {
      addNote(newCg.id, note);
    }
  }, [addCaregiver, addNote]);

  return (
    <>
      <Dashboard
        caregivers={filtered}
        allCaregivers={allCaregivers}
        filterPhase={filterPhase}
        searchTerm={searchTerm}
        setSearchTerm={setSearchTerm}
        sidebarWidth={sidebarCollapsed ? 64 : 260}
        onSelect={(id) => navigate(`/caregiver/${id}`)}
        onAdd={() => navigate('/add')}
        onImportIndeed={() => setShowIndeedImport(true)}
        onBulkPhaseOverride={bulkPhaseOverride}
        onBulkAddNote={bulkAddNote}
        onBulkBoardStatus={bulkBoardStatus}
        onBulkArchive={bulkArchive}
        onBulkSms={bulkSms}
        showToast={showToast}
      />
      {showIndeedImport && (
        <IndeedImportModal
          onClose={() => setShowIndeedImport(false)}
          onImport={handleImportCaregiver}
          existingCaregivers={[...onboardingCaregivers, ...archivedCaregivers]}
        />
      )}
    </>
  );
}

function BoardPage() {
  const navigate = useNavigate();
  const { caregivers: allCaregivers, activeCaregivers, updateBoardStatus, updateBoardNote, updateBoardLabels, updateBoardChecklists, updateBoardDueDate, updateBoardDescription, addNote, addCaregiver } = useCaregivers();
  const { currentUserName } = useApp();

  const handleAddCard = useCallback((entityId, columnId) => {
    if (!entityId) {
      const newCg = addCaregiver({ firstName: 'New', lastName: 'Card' });
      updateBoardStatus(newCg.id, columnId);
      return;
    }
    updateBoardStatus(entityId, columnId);
  }, [updateBoardStatus, addCaregiver]);

  const allAvailable = useMemo(() => allCaregivers.filter((cg) => !cg.archived), [allCaregivers]);

  return (
    <KanbanBoard
      caregivers={activeCaregivers}
      onUpdateStatus={updateBoardStatus}
      onUpdateNote={updateBoardNote}
      onUpdateLabels={updateBoardLabels}
      onUpdateChecklists={updateBoardChecklists}
      onUpdateDueDate={updateBoardDueDate}
      onUpdateDescription={updateBoardDescription}
      onAddNote={addNote}
      onSelect={(id) => navigate(`/caregiver/${id}`)}
      currentUserName={currentUserName}
      onAddCard={handleAddCard}
      availableEntities={allAvailable}
    />
  );
}

function BoardsIndexPage() {
  return <BoardsIndex />;
}

function MultiBoardPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { currentUserName } = useApp();
  const { boards, loadCards, getCards, updateCard, addCard, removeCard, updateBoard } = useBoards();
  const { caregivers: allCaregivers, activeCaregivers, addNote } = useCaregivers();
  const { clients: allClients, activeClients } = useClients();

  const board = useMemo(() => boards.find((b) => b.id === id), [boards, id]);

  useEffect(() => {
    if (id) loadCards(id);
  }, [id, loadCards]);

  const boardCards = getCards(id);

  const mergedCards = useMemo(() => {
    if (!board) return [];
    return boardCards.map((card) => {
      let entity = null;
      if (card.entityType === 'caregiver') {
        entity = activeCaregivers.find((cg) => cg.id === card.entityId);
      } else if (card.entityType === 'client') {
        entity = activeClients.find((cl) => cl.id === card.entityId);
      }
      if (!entity) {
        entity = { id: card.entityId, firstName: '(Unknown)', lastName: '' };
      }
      return {
        ...entity,
        id: card.entityId,
        _cardId: card.id,
        boardStatus: card.columnId,
        boardLabels: card.labels || [],
        boardChecklists: card.checklists || [],
        boardDueDate: card.dueDate || null,
        boardDescription: card.description || null,
        boardNote: card.pinnedNote || null,
        boardMovedAt: card.movedAt ? new Date(card.movedAt).getTime() : null,
      };
    });
  }, [boardCards, activeCaregivers, activeClients, board]);

  const allEntitiesOnBoard = useMemo(() => {
    if (!board) return mergedCards;
    const onBoardIds = new Set(boardCards.map((c) => c.entityId));
    if (board.entityType === 'caregiver') {
      const autoInclude = activeCaregivers
        .filter((cg) => !onBoardIds.has(cg.id) && getOverallProgress(cg) === 100)
        .map((cg) => ({
          ...cg,
          boardStatus: null,
          boardLabels: [],
          boardChecklists: [],
          boardDueDate: null,
          boardDescription: null,
          boardNote: null,
          boardMovedAt: null,
          _autoIncluded: true,
        }));
      return [...mergedCards, ...autoInclude];
    }
    return mergedCards;
  }, [mergedCards, boardCards, activeCaregivers, board]);

  const handleUpdateStatus = useCallback((entityId, status) => {
    const card = boardCards.find((c) => c.entityId === entityId);
    if (card) {
      updateCard(id, entityId, { columnId: status, movedAt: new Date().toISOString() });
    } else {
      const entityType = board?.entityType || 'caregiver';
      addCard(id, entityId, entityType, status);
    }
  }, [boardCards, id, updateCard, addCard, board?.entityType]);

  const handleUpdateNote = useCallback((entityId, note) => {
    const card = boardCards.find((c) => c.entityId === entityId);
    if (card) {
      updateCard(id, entityId, { pinnedNote: note });
    }
  }, [boardCards, id, updateCard]);

  const handleUpdateLabels = useCallback((entityId, labelIds) => {
    const card = boardCards.find((c) => c.entityId === entityId);
    if (card) {
      updateCard(id, entityId, { labels: labelIds });
    }
  }, [boardCards, id, updateCard]);

  const handleUpdateChecklists = useCallback((entityId, checklists) => {
    const card = boardCards.find((c) => c.entityId === entityId);
    if (card) {
      updateCard(id, entityId, { checklists });
    }
  }, [boardCards, id, updateCard]);

  const handleUpdateDueDate = useCallback((entityId, dueDate) => {
    const card = boardCards.find((c) => c.entityId === entityId);
    if (card) {
      updateCard(id, entityId, { dueDate });
    }
  }, [boardCards, id, updateCard]);

  const handleUpdateDescription = useCallback((entityId, description) => {
    const card = boardCards.find((c) => c.entityId === entityId);
    if (card) {
      updateCard(id, entityId, { description });
    }
  }, [boardCards, id, updateCard]);

  const handleBoardUpdate = useCallback((updates) => {
    if (!board) return;
    updateBoard(id, updates);
  }, [id, board, updateBoard]);

  const handleAddCard = useCallback(async (entityId, columnId) => {
    if (!entityId) {
      const blankId = 'blank_' + crypto.randomUUID().slice(0, 8);
      await addCard(id, blankId, 'custom', columnId || null);
      return;
    }
    const entityType = board?.entityType || 'caregiver';
    await addCard(id, entityId, entityType, columnId || null);
  }, [id, board?.entityType, addCard]);

  const handleRemoveCard = useCallback(async (entityId) => {
    const card = boardCards.find((c) => c.entityId === entityId);
    if (card) {
      await removeCard(id, card.id);
    }
  }, [boardCards, id, removeCard]);

  const handleSelect = useCallback((entityId) => {
    if (board?.entityType === 'client') {
      navigate(`/clients/${entityId}`);
    } else {
      navigate(`/caregiver/${entityId}`);
    }
  }, [navigate, board?.entityType]);

  if (!board) {
    return (
      <div style={{ textAlign: 'center', padding: '80px 24px', color: '#7A8BA0' }}>
        <h2 style={{ color: '#0F1724', marginBottom: 8 }}>Board not found</h2>
        <button className={btn.secondaryBtn} style={{ marginTop: 16 }} onClick={() => navigate('/boards')}>
          Back to Boards
        </button>
      </div>
    );
  }

  return (
    <KanbanBoard
      caregivers={allEntitiesOnBoard}
      onUpdateStatus={handleUpdateStatus}
      onUpdateNote={handleUpdateNote}
      onUpdateLabels={handleUpdateLabels}
      onUpdateChecklists={handleUpdateChecklists}
      onUpdateDueDate={handleUpdateDueDate}
      onUpdateDescription={handleUpdateDescription}
      onAddNote={addNote}
      onSelect={handleSelect}
      currentUserName={currentUserName}
      board={board}
      onBoardUpdate={handleBoardUpdate}
      onAddCard={handleAddCard}
      onRemoveCard={handleRemoveCard}
      availableEntities={board.entityType === 'client' ? allClients.filter((c) => !c.archived) : allCaregivers.filter((c) => !c.archived)}
      boardTitle={board.name}
      boardSubtitle={board.description || 'Drag cards between columns to organize your work'}
    />
  );
}

function RosterPage() {
  const navigate = useNavigate();
  const { sidebarCollapsed, showToast } = useApp();
  const { rosterCaregivers, updateCaregiver, bulkSms, bulkAddNote, bulkArchive } = useCaregivers();

  return (
    <ActiveRoster
      caregivers={rosterCaregivers}
      onSelect={(id) => navigate(`/caregiver/${id}`)}
      onUpdateCaregiver={updateCaregiver}
      onBulkSms={bulkSms}
      onBulkAddNote={bulkAddNote}
      onBulkArchive={bulkArchive}
      showToast={showToast}
      sidebarWidth={sidebarCollapsed ? 64 : 260}
    />
  );
}

function AddCaregiverPage() {
  const navigate = useNavigate();
  const { addCaregiver, caregivers } = useCaregivers();

  return (
    <AddCaregiver
      caregivers={caregivers}
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
  const { showToast, currentUserName, currentUserEmail, currentUserMailbox } = useApp();
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
      currentUser={{ displayName: currentUserName, email: currentUserEmail, mailboxEmail: currentUserMailbox }}
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

// ─── Client Route Pages ───

function ClientDashboardPage() {
  const navigate = useNavigate();
  const { sidebarCollapsed, showToast } = useApp();
  const { activeClients, archivedClients, filterPhase, tasksVersion, bulkEmail } = useClients();
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
      onBulkEmail={bulkEmail}
      showToast={showToast}
    />
  );
}

function ActiveClientsPage() {
  const navigate = useNavigate();
  const { sidebarCollapsed, showToast } = useApp();
  const { activeClients, tasksVersion, bulkEmail } = useClients();
  const [searchTerm, setSearchTerm] = useState('');

  const wonClients = useMemo(
    () => activeClients.filter((cl) => getClientPhase(cl) === 'won'),
    [activeClients, tasksVersion]
  );

  const filtered = useMemo(() => {
    if (!searchTerm) return wonClients;
    const q = searchTerm.toLowerCase();
    return wonClients.filter((cl) =>
      `${cl.firstName} ${cl.lastName}`.toLowerCase().includes(q) ||
      cl.phone?.includes(searchTerm) ||
      cl.email?.toLowerCase().includes(q) ||
      cl.careRecipientName?.toLowerCase().includes(q)
    );
  }, [wonClients, searchTerm]);

  return (
    <ClientDashboard
      clients={filtered}
      allClients={wonClients}
      filterPhase="won"
      searchTerm={searchTerm}
      setSearchTerm={setSearchTerm}
      sidebarWidth={sidebarCollapsed ? 64 : 260}
      onSelect={(id) => navigate(`/clients/${id}`)}
      onAdd={() => navigate('/clients/add')}
      onBulkEmail={bulkEmail}
      showToast={showToast}
    />
  );
}

function AddClientPage() {
  const navigate = useNavigate();
  const { addClient } = useClients();

  return (
    <AddClient
      mode="client"
      onAdd={(data) => {
        const newCl = addClient(data, { phase: 'won' });
        navigate(`/clients/${newCl.id}`);
      }}
      onCancel={() => navigate('/clients/active')}
    />
  );
}

function AddLeadPage() {
  const navigate = useNavigate();
  const { addClient } = useClients();

  return (
    <AddClient
      mode="lead"
      onAdd={(data) => {
        const newCl = addClient(data, { phase: 'new_lead' });
        navigate(`/clients/${newCl.id}`);
      }}
      onCancel={() => navigate('/clients')}
    />
  );
}

function ClientDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { showToast, currentUserName, currentUserEmail, currentUserMailbox } = useApp();
  const {
    clients, activeClients,
    updateTask, updateTasksBulk, addNote, updatePhase,
    archiveClient, unarchiveClient, deleteClient, updateClient,
    refreshClientTasks,
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
      currentUser={{ displayName: currentUserName, email: currentUserEmail, mailboxEmail: currentUserMailbox }}
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
      onRefreshTasks={refreshClientTasks}
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

function BoardProviderBridge({ children }) {
  const { activeCaregivers } = useCaregivers();
  return <BoardProvider caregivers={activeCaregivers}>{children}</BoardProvider>;
}

export default function AdminApp() {
  const { handleUserReady, handleLogout, currentUserName } = useApp();

  return (
    <AuthGate onUserReady={handleUserReady} onLogout={handleLogout}>
      <CaregiverProvider>
        <ClientProvider>
          <BoardProviderBridge>
            <Routes>
              <Route element={<AppShell />}>
                <Route index element={<DashboardPage />} />
                <Route path="board" element={<BoardPage />} />
                <Route path="boards" element={<BoardsIndexPage />} />
                <Route path="boards/:id" element={<MultiBoardPage />} />
                <Route path="roster" element={<RosterPage />} />
                <Route path="add" element={<AddCaregiverPage />} />
                <Route path="caregiver/:id" element={<CaregiverDetailPage />} />
                <Route path="clients" element={<ClientDashboardPage />} />
                <Route path="clients/active" element={<ActiveClientsPage />} />
                <Route path="clients/add" element={<AddClientPage />} />
                <Route path="clients/add-lead" element={<AddLeadPage />} />
                <Route path="clients/sequences" element={<SequenceSettingsPage />} />
                <Route path="clients/:id" element={<ClientDetailPage />} />
                <Route path="schedule" element={<SchedulePage />} />
                <Route path="settings" element={<SettingsPage />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Routes>
            <AIChatbot caregiverId={null} currentUser={currentUserName} />
          </BoardProviderBridge>
        </ClientProvider>
      </CaregiverProvider>
    </AuthGate>
  );
}
