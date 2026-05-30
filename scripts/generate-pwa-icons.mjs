// ─── PWA icon generator ───
// Rasterizes the Tremendous Care brand mark into the PNG sizes the
// caregiver PWA needs for Android, iOS, and maskable home-screen icons.
//
// Why committed PNGs instead of shipping the SVG directly: iOS does not
// support SVG for `apple-touch-icon`, and maskable icons must be
// full-bleed so the platform mask never clips the logo. We generate
// deterministic PNGs from inline SVG (font-independent: a generic
// sans-serif is used so the render does not depend on the brand webfont
// being installed on the build machine).
//
// Re-run after a brand change:  node scripts/generate-pwa-icons.mjs
//
// Outputs (public/icons/):
//   icon-192.png             192x192  purpose "any"  (rounded)
//   icon-512.png             512x512  purpose "any"  (rounded)
//   icon-maskable-512.png    512x512  purpose "maskable" (full-bleed, safe zone)
//   apple-touch-icon-180.png 180x180  iOS home screen (full-bleed square)

import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'public', 'icons');

// Brand gradient: navy → cyan (matches tokens.css / care-manifest theme).
const NAVY = '#2E4E8D';
const CYAN = '#29BEE4';

// A generic sans family so rasterization never depends on the Outfit
// webfont being present on the build host.
const FONT = "'DejaVu Sans', system-ui, sans-serif";

// `cornerRadius` rounds the tile (0 = full-bleed square). `glyphScale`
// shrinks the "TC" mark so maskable/apple variants keep the lettermark
// inside the platform safe zone.
function buildSvg({ size, cornerRadius, glyphScale }) {
  const fontSize = Math.round(size * 0.43 * glyphScale);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${NAVY}"/>
      <stop offset="1" stop-color="${CYAN}"/>
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" rx="${cornerRadius}" fill="url(#g)"/>
  <text x="50%" y="50%" dy="0.02em" dominant-baseline="central" text-anchor="middle"
        font-family="${FONT}" font-size="${fontSize}" font-weight="bold" fill="#FFFFFF">TC</text>
</svg>`;
}

async function render(svg, size, outFile) {
  const png = await sharp(Buffer.from(svg)).resize(size, size).png().toBuffer();
  await writeFile(join(OUT_DIR, outFile), png);
  console.log(`  wrote icons/${outFile} (${png.length} bytes)`);
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  console.log('Generating PWA icons →', OUT_DIR);

  // Rounded "any" icons (Android adaptive layers add their own mask, but
  // Chrome also uses these as-is in some surfaces, so keep gentle corners).
  await render(buildSvg({ size: 192, cornerRadius: 36, glyphScale: 1 }), 192, 'icon-192.png');
  await render(buildSvg({ size: 512, cornerRadius: 96, glyphScale: 1 }), 512, 'icon-512.png');

  // Maskable: full-bleed gradient, lettermark shrunk into the ~80% safe zone.
  await render(buildSvg({ size: 512, cornerRadius: 0, glyphScale: 0.72 }), 512, 'icon-maskable-512.png');

  // Apple touch: full-bleed square; iOS applies its own rounded mask.
  await render(buildSvg({ size: 180, cornerRadius: 0, glyphScale: 0.82 }), 180, 'apple-touch-icon-180.png');

  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
