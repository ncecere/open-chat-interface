// Renders the installable app's PNG icons (#400) from the mark in
// public/favicon.svg, with Chromium through Playwright (no image library).
//
//   pnpm --filter @oci/web exec node scripts/render-icons.mjs
//
// The PNGs in public/icons/ are committed; run this only when the mark changes.
//   icon-192.png, icon-512.png   the mark on its rounded tile, transparent corners
//   icon-maskable-512.png        the mark on a full-bleed square, scaled to sit
//                                inside the central 80% circle (the maskable safe
//                                zone), so a launcher's circle or squircle crop
//                                never touches it
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const favicon = readFileSync(resolve(root, 'public/favicon.svg'), 'utf8');

// The mark's two shapes, and the tile colour, as favicon.svg draws them.
const shapes = [...favicon.matchAll(/<path [^>]*\/>/g)].map((match) => match[0]);
const tile = favicon.match(/<rect [^>]*fill="(#[0-9a-f]{6})"/i)?.[1];
if (shapes.length !== 2 || !tile) throw new Error('favicon.svg no longer has the expected shapes');

// The mark spans x 12..52 and y 11..54.75 of the 64-unit box (stroke caps
// included): centred at (32, 32.875). At 0.8 its farthest corner is 23.8 units
// from the centre, inside the safe-zone radius of 25.6 (40% of 64).
const MASK_SCALE = 0.8;
const maskable = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<rect width="64" height="64" fill="${tile}"/>
<g transform="translate(32 32) scale(${MASK_SCALE}) translate(-32 -32.875)">${shapes.join('')}</g>
</svg>`;

const icons = [
  { file: 'icon-192.png', size: 192, svg: favicon, transparent: true },
  { file: 'icon-512.png', size: 512, svg: favicon, transparent: true },
  { file: 'icon-maskable-512.png', size: 512, svg: maskable, transparent: false },
];

mkdirSync(resolve(root, 'public/icons'), { recursive: true });
const browser = await chromium.launch();
try {
  for (const icon of icons) {
    const page = await browser.newPage({
      viewport: { width: icon.size, height: icon.size },
      deviceScaleFactor: 1,
    });
    await page.setContent(
      `<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block;width:${icon.size}px;height:${icon.size}px}</style>${icon.svg.replace(
        /<svg ([^>]*?) role="img" aria-label="[^"]*"/,
        '<svg $1',
      )}`,
    );
    const png = await page.screenshot({ omitBackground: icon.transparent, type: 'png' });
    writeFileSync(resolve(root, 'public/icons', icon.file), png);
    await page.close();
    console.log(`public/icons/${icon.file} ${png.length} bytes`);
  }
} finally {
  await browser.close();
}
