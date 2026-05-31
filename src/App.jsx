import { lazy, Suspense, useEffect } from 'react';
import { Routes, Route, useLocation } from 'react-router-dom';
import { isOfficeRoute } from './pwa/routeScope';

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
const BDApp = lazy(() =>
  import('./features/bd-portal/BDApp').then((m) => ({ default: m.BDApp })),
);
const PrivacyPolicy = lazy(() =>
  import('./features/legal/PrivacyPolicy').then((m) => ({ default: m.PrivacyPolicy })),
);
const TermsOfService = lazy(() =>
  import('./features/legal/TermsOfService').then((m) => ({ default: m.TermsOfService })),
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

  // Keep the PWA install identity in sync with the current surface across
  // client-side navigation. index.html's head script sets this at the initial
  // page load, but react-router moves between surfaces without a reload (e.g.
  // the BD drawer navigates into admin routes), so re-select the manifest +
  // iOS app title on every route change. Real static files only — iOS ignores
  // blob/late-injected manifests at Add-to-Home-Screen time.
  useEffect(() => {
    const link = document.querySelector('link[rel="manifest"]');
    const title = document.querySelector('meta[name="apple-mobile-web-app-title"]');
    const office = isOfficeRoute(location.pathname);
    if (link) {
      link.setAttribute('href', office ? '/office-manifest.webmanifest' : '/care-manifest.webmanifest');
    }
    if (title) {
      title.setAttribute('content', office ? 'TC Office' : 'Tremendous Care');
    }
  }, [location.pathname]);

  // Public routes — no auth required, rendered without admin shell.
  // Legal pages are public so Intuit (and other partners) can review
  // them without an account; they back the QuickBooks production listing.
  if (location.pathname === '/privacy') {
    return (
      <Suspense fallback={<RouteFallback />}>
        <PrivacyPolicy />
      </Suspense>
    );
  }
  if (location.pathname === '/terms') {
    return (
      <Suspense fallback={<RouteFallback />}>
        <TermsOfService />
      </Suspense>
    );
  }
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
  // BD PWA — separate mobile-first surface for the BD rep.
  // Same auth as the admin portal (Supabase session) but rendered
  // without the admin shell.
  if (location.pathname === '/bd' || location.pathname.startsWith('/bd/')) {
    return (
      <Suspense fallback={<RouteFallback />}>
        <BDApp />
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
