import { Routes, Route, Navigate } from 'react-router-dom';
import { useCaregiverSession } from './hooks/useCaregiverSession';
import { CaregiverLogin } from './CaregiverLogin';
import { CaregiverShifts } from './CaregiverShifts';
import { CaregiverShiftDetail } from './CaregiverShiftDetail';
import { supabase } from '../../lib/supabase';
import s from './CaregiverPortal.module.css';

export function CaregiverApp() {
  const { loading, session, caregiver, linkError, refresh } = useCaregiverSession();

  if (loading) {
    return (
      <div className={s.centered}>
        <div className={s.spinner} aria-label="Loading" />
      </div>
    );
  }

  if (!session) {
    return <CaregiverLogin />;
  }

  // Authed but not linked to a caregiver record (rare — usually only
  // if an admin hasn't added the caregiver yet, or the email doesn't
  // match). Show a clear message so the caregiver knows to call in.
  if (!caregiver) {
    return (
      <div className={s.centered}>
        <div className={s.card}>
          <h1 className={s.title}>Welcome</h1>
          <p className={s.muted}>
            You&rsquo;re signed in, but we couldn&rsquo;t find a caregiver record linked to{' '}
            <strong>{session.user?.email}</strong>.
          </p>
          {linkError && <p className={s.error}>{linkError}</p>}
          <p className={s.muted}>
            Please contact your coordinator so they can link your account.
          </p>
          <div className={s.row}>
            <button
              type="button"
              className={s.secondaryBtn}
              onClick={refresh}
            >
              Try again
            </button>
            <button
              type="button"
              className={s.secondaryBtn}
              onClick={() => supabase.auth.signOut()}
            >
              Sign out
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <Routes>
      <Route path="/care" element={<CaregiverShifts caregiver={caregiver} />} />
      <Route path="/care/shifts/:shiftId" element={<CaregiverShiftDetail caregiver={caregiver} />} />
      <Route path="/care/*" element={<Navigate to="/care" replace />} />
    </Routes>
  );
}
