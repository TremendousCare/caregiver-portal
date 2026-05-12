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
  const { toast, isAdmin, currentOrgSettings } = useApp();
  const { loaded: caregiversLoaded, setFilterPhase } = useCaregivers();
  const { loaded: clientsLoaded, setFilterPhase: setClientFilterPhase } = useClients();
  const { boards, loaded: boardsLoaded } = useBoards();

  const loaded = caregiversLoaded && clientsLoaded;

  // Accounting visibility gate. Show when:
  //   - the user is an admin (members don't see Payroll or Invoicing), AND
  //   - the org has at least one Accounting sub-feature enabled
  //     (features_enabled.payroll OR features_enabled.invoicing).
  // The route is also gated by AdminOnly in AdminApp.jsx, so a member
  // who types the URL directly hits the access-denied panel.
  const payrollEnabled = currentOrgSettings?.features_enabled?.payroll === true;
  const invoicingEnabled = currentOrgSettings?.features_enabled?.invoicing === true;
  const accountingVisible = isAdmin && (payrollEnabled || invoicingEnabled);

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
        id: 'clients',
        label: 'Clients',
        items: [
          { id: 'active-clients', path: '/clients/active', icon: '✅', label: 'Active Clients' },
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
      ...(accountingVisible ? [{
        id: 'accounting',
        label: 'Accounting',
        items: [
          // Single entry into the Accounting page; sub-tabs (Payroll,
          // Invoicing) are switched in-page. The icon and label adapt
          // based on which features are enabled.
          {
            id: 'accounting-main',
            path: '/accounting',
            icon: invoicingEnabled && !payrollEnabled ? '🧾' : '💰',
            label: payrollEnabled && invoicingEnabled
              ? 'Payroll & Invoicing'
              : payrollEnabled
                ? 'Payroll'
                : 'Invoicing',
          },
        ],
      }] : []),
      {
        id: 'boards',
        label: 'Boards',
        items: [
          { id: 'boards-index', path: '/boards', icon: '📋', label: 'All Boards' },
          ...boardItems,
        ],
      },
      {
        id: 'bd',
        label: 'Business Development',
        items: [
          // BD Portal stays visible to everyone; the funnel report and
          // goals editor are admin-only (matches the AdminOnly route
          // guard in AdminApp.jsx).
          { id: 'bd-portal',  path: '/bd',         icon: '📱', label: 'BD Portal' },
          ...(isAdmin ? [
            { id: 'bd-funnel',  path: '/bd-funnel',  icon: '📊', label: 'Funnel Report' },
            { id: 'bd-goals',   path: '/bd-goals',   icon: '🎯', label: 'Goals' },
          ] : []),
        ],
      },
      // Phase 1.4 — admin-only per-agent metrics dashboard. Phase 1.5
      // — retrospective grading UI. Both live under the AI Agents
      // section; future agent-related pages (marketplace, manifest
      // editor, etc.) get added here too.
      ...(isAdmin ? [{
        id: 'ai-agents',
        label: 'AI Agents',
        items: [
          { id: 'agent-metrics', path: '/agent-metrics', icon: '🤖', label: 'Agent Metrics' },
          { id: 'agent-grading', path: '/agent-grading', icon: '✏️', label: 'Suggestion Grading' },
        ],
      }] : []),
      // Future:
      // { id: 'billing', label: 'Billing', items: [...] },
    ];
  }, [setFilterPhase, setClientFilterPhase, boards, accountingVisible, isAdmin, payrollEnabled, invoicingEnabled]);

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
