import { useMemo } from 'react';
import { Outlet } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import { useCaregivers } from '../context/CaregiverContext';
import { useClients } from '../context/ClientContext';
import { useBoards } from '../context/BoardContext';
import { Sidebar } from './Sidebar';
import { Toast } from '../components/Toast';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { CaregiverSidebarExtra } from '../../features/caregivers/CaregiverSidebarExtra';
import { ClientSidebarExtra } from '../../features/clients/ClientSidebarExtra';
import layout from '../../styles/layout.module.css';

export function AppShell() {
  const { toast } = useApp();
  const { loaded: caregiversLoaded, setFilterPhase } = useCaregivers();
  const { loaded: clientsLoaded, setFilterPhase: setClientFilterPhase } = useClients();
  const { boards, loaded: boardsLoaded } = useBoards();

  const loaded = caregiversLoaded && clientsLoaded;

  // ─── Sidebar section configs ───
  // Each module registers its section here. Future modules (Scheduling, Billing)
  // will add their own entries to this array.
  const sidebarSections = useMemo(() => {
    // Build dynamic board items from loaded boards
    const boardItems = boards.map((b) => ({
      id: `board-${b.id}`,
      path: `/boards/${b.id}`,
      icon: (b.columns?.[0]?.icon) || '▤',
      label: b.name,
    }));

    return [
      {
        id: 'caregivers',
        label: 'Caregivers',
        items: [
          { id: 'dashboard', path: '/', icon: '⊞', label: 'Dashboard', onNavigate: () => setFilterPhase('all') },
          { id: 'board', path: '/board', icon: '▤', label: 'Caregiver Board' },
          { id: 'roster', path: '/roster', icon: '👥', label: 'Active Roster' },
          { id: 'add', path: '/add', icon: '＋', label: 'New Caregiver' },
        ],
        extra: <CaregiverSidebarExtra />,
      },
      {
        id: 'boards',
        label: 'Boards',
        items: [
          { id: 'boards-index', path: '/boards', icon: '📋', label: 'All Boards' },
          ...boardItems,
        ],
      },
      {
        id: 'clients',
        label: 'Client Pipeline',
        items: [
          { id: 'clients-dashboard', path: '/clients', icon: '🏠', label: 'Clients', onNavigate: () => setClientFilterPhase('all') },
          { id: 'add-client', path: '/clients/add', icon: '＋', label: 'New Client' },
          { id: 'sequences', path: '/clients/sequences', icon: '⚡', label: 'Sequences' },
        ],
        extra: <ClientSidebarExtra />,
      },
      {
        id: 'scheduling',
        label: 'Scheduling',
        items: [
          { id: 'schedule', path: '/schedule', icon: '📅', label: 'Calendar' },
        ],
      },
      // Future:
      // { id: 'billing', label: 'Billing', items: [...] },
    ];
  }, [setFilterPhase, setClientFilterPhase, boards]);

  return (
    <div className={layout.app}>
      <Toast message={toast} />
      <Sidebar sections={sidebarSections} />

      <main className={layout.main}>
        {!loaded ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh', color: '#7A8BA0', fontSize: 15 }}>
            Loading data...
          </div>
        ) : (
          <ErrorBoundary name="Content">
            <div className="tc-page-enter">
              <Outlet />
            </div>
          </ErrorBoundary>
        )}
      </main>
    </div>
  );
}
