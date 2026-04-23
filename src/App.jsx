import { lazy, Suspense } from 'react';
import { Routes, Route, useLocation } from 'react-router-dom';

// Everything is lazy-loaded behind the route split so the caregiver PWA
// and public /apply, /upload, /sign, /survey pages don't ship the admin
// bundle. Caregiver first-load on 5G was 10–30s because AdminApp pulled
// Dashboard, Kanban, SchedulePage, AIChatbot, etc. as static imports.
const AdminApp = lazy(() => import('./AdminApp'));
const ApplyPage = lazy(() =>
  import('./features/apply/ApplyPage').then((m) => ({ default: m.ApplyPage })),
);
const UploadPage = lazy(() =>
  import('./features/upload/UploadPage').then((m) => ({ default: m.UploadPage })),
);
const SigningPage = lazy(() =>
  import('./features/sign/SigningPage').then((m) => ({ default: m.SigningPage })),
);
const SurveyPage = lazy(() =>
  import('./features/survey/SurveyPage').then((m) => ({ default: m.SurveyPage })),
);
const CaregiverApp = lazy(() =>
  import('./features/caregiver-portal/CaregiverApp').then((m) => ({ default: m.CaregiverApp })),
);

function RouteFallback() {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ color: '#7A8BA0' }}>Loading…</div>
    </div>
  );
}

export default function App() {
  const location = useLocation();

  // Public routes — no auth required, rendered without admin shell.
  if (location.pathname === '/apply') {
    return (
      <Suspense fallback={<RouteFallback />}>
        <ApplyPage />
      </Suspense>
    );
  }
  if (location.pathname.startsWith('/upload/')) {
    return (
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/upload/:token" element={<UploadPage />} />
        </Routes>
      </Suspense>
    );
  }
  if (location.pathname.startsWith('/sign/')) {
    return (
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/sign/:token" element={<SigningPage />} />
        </Routes>
      </Suspense>
    );
  }
  if (location.pathname.startsWith('/survey/')) {
    return (
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/survey/:token" element={<SurveyPage />} />
        </Routes>
      </Suspense>
    );
  }
  // Caregiver PWA — separate auth/shell from the admin portal.
  // Match only `/care` exactly or `/care/<subpath>`, NOT `/caregiver/:id`
  // or other `/care`-prefixed admin routes.
  if (location.pathname === '/care' || location.pathname.startsWith('/care/')) {
    return (
      <Suspense fallback={<RouteFallback />}>
        <CaregiverApp />
      </Suspense>
    );
  }

  // Everything else is the admin portal.
  return (
    <Suspense fallback={<RouteFallback />}>
      <AdminApp />
    </Suspense>
  );
}
