import { useMemo } from 'react';
import { Outlet } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import { useCaregivers } from '../context/CaregiverContext';
import { Sidebar } from './Sidebar';
import { Toast } from '../components/Toast';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { CaregiverSidebarExtra } from '../../features/caregivers/CaregiverSidebarExtra';
import layout from '../../styles/layout.module.css';

export function AppShell() {
  const { toast } = useApp();
  const { loaded, setFilterPhase } = useCaregivers();

  // ─── Sidebar section configs ───
  // Each module registers its section here. Future modules (Pipeline, Scheduling, Billing)
  // will add their own entries to this array.
  const sidebarSections = useMemo(() => [
    {
      id: 'caregivers',
      label: 'Caregivers',
      items: [
        { id: 'dashboard', path: '/', icon: '⊞', label: 'Dashboard', onNavigate: () => setFilterPhase('all') },
        { id: 'board', path: '/board', icon: '▤', label: 'Caregiver Board' },
        { id: 'add', path: '/add', icon: '＋', label: 'New Caregiver' },
      ],
      extra: <CaregiverSidebarExtra />,
    },
    // Future:
    // { id: 'pipeline', label: 'Pipeline', items: [...], extra: <PipelineSidebarExtra /> },
    // { id: 'scheduling', label: 'Scheduling', items: [...] },
    // { id: 'billing', label: 'Billing', items: [...] },
  ], [setFilterPhase]);

  return (
    <div className={layout.app}>
      <Toast message={toast} />
      <Sidebar sections={sidebarSections} />

      <main className={layout.main}>
        {!loaded ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh', color: '#7A8BA0', fontSize: 15 }}>
            Loading caregivers...
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
