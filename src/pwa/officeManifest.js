// ─── Office PWA app identity (manifest) ───
// The office/admin app shares a single index.html with the caregiver app
// (which links the static `/care-manifest.webmanifest`, scoped to /care).
// To make the office app installable as its OWN app — with its own icon,
// name, and a window scoped to the whole portal at `/` — we swap in a
// distinct manifest at runtime, and ONLY on office routes. The caregiver
// manifest/SW are never touched.
//
// Branding is data-driven on purpose (CLAUDE.md Prime Directive #5): the
// values live in one place (`OFFICE_BRANDING`) and `resolveOfficeBranding`
// layers any per-org branding from `organizations.settings` on top. Today
// org settings carry no branding block, so every org falls back to the
// Tremendous Care defaults — but when Phase D adds per-org branding, the
// install identity follows automatically with no code change here.

// Single source of truth for the office app's install identity.
// When selling to other agencies, this is the one place to change — or,
// better, leave it as the fallback and let `organizations.settings.branding`
// override it per org (see `resolveOfficeBranding`).
export const OFFICE_BRANDING = {
  name: 'Tremendous Care — Office',
  short_name: 'TC Office',
  description:
    'Tremendous Care staff portal — caregivers, clients, scheduling, and operations.',
  theme_color: '#2E4E8D',
  background_color: '#F7F8FB',
  icons: [
    { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
};

// Merge any per-org branding (organizations.settings.branding) over the
// defaults. Unknown/missing fields fall back, so a partial override (just a
// name, say) is safe. Pure — no DOM, no globals — so it is unit-testable.
export function resolveOfficeBranding(orgSettings) {
  const b = orgSettings && orgSettings.branding ? orgSettings.branding : {};
  return {
    name: b.name || OFFICE_BRANDING.name,
    short_name: b.short_name || OFFICE_BRANDING.short_name,
    description: b.description || OFFICE_BRANDING.description,
    theme_color: b.theme_color || OFFICE_BRANDING.theme_color,
    background_color: b.background_color || OFFICE_BRANDING.background_color,
    // Icons are an all-or-nothing override: a partial icon list would risk an
    // invalid manifest, so only swap when a non-empty array is supplied.
    icons: Array.isArray(b.icons) && b.icons.length ? b.icons : OFFICE_BRANDING.icons,
  };
}

// Build a Web App Manifest object for the office surface. Scoped to `/` so
// the whole portal opens inside the installed window; `start_url` lands on
// the dashboard. When an `origin` is given, all URLs are made absolute —
// required because the manifest is served from a `blob:` URL, against which
// relative icon/start_url paths would not resolve. Pure & testable.
export function buildOfficeManifest(branding = OFFICE_BRANDING, origin = '') {
  const abs = (p) => {
    if (!origin) return p;
    try {
      return new URL(p, origin).href;
    } catch {
      return p;
    }
  };
  return {
    name: branding.name,
    short_name: branding.short_name,
    description: branding.description,
    id: abs('/'),
    start_url: abs('/'),
    scope: abs('/'),
    display: 'standalone',
    background_color: branding.background_color,
    theme_color: branding.theme_color,
    icons: (branding.icons || []).map((icon) => ({ ...icon, src: abs(icon.src) })),
  };
}

// Track the last blob URL so repeated injections (startup → org settings
// loaded) don't leak object URLs.
let lastManifestUrl = null;

// Swap the document's <link rel="manifest"> to a freshly-built office
// manifest. Side-effectful; kept thin so the logic above stays testable.
// Returns the manifest object (handy for tests/debugging).
export function installOfficeManifest({
  document: doc = typeof document !== 'undefined' ? document : undefined,
  branding = OFFICE_BRANDING,
  origin = typeof window !== 'undefined' ? window.location.origin : '',
} = {}) {
  if (!doc) return null;
  const manifest = buildOfficeManifest(branding, origin);
  const blob = new Blob([JSON.stringify(manifest)], {
    type: 'application/manifest+json',
  });
  const url = URL.createObjectURL(blob);

  let link = doc.querySelector('link[rel="manifest"]');
  if (!link) {
    link = doc.createElement('link');
    link.rel = 'manifest';
    doc.head.appendChild(link);
  }
  link.href = url;

  if (lastManifestUrl) URL.revokeObjectURL(lastManifestUrl);
  lastManifestUrl = url;
  return manifest;
}
