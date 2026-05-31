import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AppProvider } from './shared/context/AppContext';
import App from './App';
import { isOfficeRoute } from './pwa/routeScope';
import { installOfficeManifest } from './pwa/officeManifest';
import './styles/tokens.css';
import './styles/global.css';

// On office routes only, swap index.html's static caregiver manifest for the
// office app's own install identity (scope `/`). Caregiver and public-token
// entries keep the static `/care-manifest.webmanifest` untouched. The
// identity is upgraded to per-org branding later, in OfficePwaPrompts, once
// org settings load.
if (typeof window !== 'undefined' && isOfficeRoute(window.location.pathname)) {
  installOfficeManifest();
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <AppProvider>
        <App />
      </AppProvider>
    </BrowserRouter>
  </React.StrictMode>
);
