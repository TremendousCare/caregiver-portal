import { Routes, Route, Navigate } from 'react-router-dom';
import { useBdSession } from './hooks/useBdSession';
import { BDLogin } from './BDLogin';
import { Today } from './Today';
import { AccountList } from './AccountList';
import { AccountProfile } from './AccountProfile';
import { AccountEditor } from './AccountEditor';
import { QuickCapture } from './QuickCapture';
import { ReferralIntake } from './ReferralIntake';
import { ContactCardCapture } from './ContactCardCapture';
import { ContactEditor } from './ContactEditor';
import { RouteBuilder } from './RouteBuilder';
import { MileageList } from './MileageList';
import { MileageEntryForm } from './MileageEntryForm';
import { BottomNav } from './BottomNav';
import { BDMenuDrawer } from './BDMenuDrawer';
import { BdViewAsBanner } from './BdViewAsBanner';
import { BdViewAsProvider } from './context/BdViewAsContext';
import { supabase } from '../../lib/supabase';
import s from './BdPortal.module.css';

export function BDApp() {
  const { loading, session } = useBdSession();

  if (loading) {
    return (
      <div className={s.centered}>
        <div className={s.spinner} aria-label="Loading" />
      </div>
    );
  }

  if (!session) {
    return <BDLogin />;
  }

  const displayName =
    session.user?.user_metadata?.full_name
    || session.user?.email?.split('@')[0]
    || 'there';

  async function handleSignOut() {
    try { await supabase.auth.signOut(); } catch (e) { console.error('Sign out failed:', e); }
    window.location.assign('/bd');
  }

  return (
    <BdViewAsProvider>
      <BdViewAsBanner />
      <Routes>
        <Route path="/bd"                              element={<Today displayName={displayName} />} />
        <Route path="/bd/log"                          element={<QuickCapture />} />
        <Route path="/bd/refer"                        element={<ReferralIntake />} />
        <Route path="/bd/plan"                         element={<RouteBuilder />} />
        <Route path="/bd/mileage"                      element={<MileageList />} />
        <Route path="/bd/mileage/new"                  element={<MileageEntryForm />} />
        <Route path="/bd/mileage/:entryId"             element={<MileageEntryForm />} />
        <Route path="/bd/accounts"                     element={<AccountList />} />
        <Route path="/bd/accounts/new"                 element={<AccountEditor />} />
        <Route path="/bd/accounts/:accountId"          element={<AccountProfile />} />
        <Route path="/bd/accounts/:accountId/log"      element={<QuickCapture />} />
        <Route path="/bd/accounts/:accountId/refer"    element={<ReferralIntake />} />
        <Route path="/bd/accounts/:accountId/contact"               element={<ContactCardCapture />} />
        <Route path="/bd/accounts/:accountId/contact/new"           element={<ContactEditor />} />
        <Route path="/bd/accounts/:accountId/contact/:contactId/edit" element={<ContactEditor />} />
        <Route path="/bd/*"                                          element={<Navigate to="/bd" replace />} />
      </Routes>
      <BottomNav />
      {/* Hamburger menu — opens a drawer with links into the rest of
          the admin app (Dashboard, Schedule, Boards, etc.) so the rep
          isn't trapped inside the BD surface. Mirrors the existing
          sign-out floating button, top-left. */}
      <BDMenuDrawer onSignOut={handleSignOut} />
      {/* Floating sign-out — hidden inside a tiny corner so the bottom
          nav stays as the primary navigation. Dev/owner can use it
          when switching accounts. */}
      <button
        type="button"
        onClick={handleSignOut}
        className={s.signOutBtn}
        style={{ position: 'fixed', top: 12, right: 12, zIndex: 11 }}
      >
        Sign out
      </button>
    </BdViewAsProvider>
  );
}
