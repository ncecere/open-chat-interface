#!/usr/bin/env node
/**
 * Keeps only the font files PDF export uses (v0.10) in the installed
 * Fontsource packages, so the API image grows by about 14 MB rather than the
 * packages' 220 MB (every weight, in WOFF and WOFF2). Run in the image build
 * after `pnpm --filter @oci/api... build`; the face list comes from the built
 * `pdf-font-faces.js`, the same list the generator reads.
 *
 *   node apps/api/scripts/prune-pdf-fonts.mjs [--dry-run]
 *
 * Each package keeps its licence, package.json, unicode.json, metadata.json
 * and index.css (what `require.resolve` finds), plus the listed slices.
 */
import { readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const api = join(dirname(fileURLToPath(import.meta.url)), '..');
const dryRun = process.argv.includes('--dry-run');
const { PDF_FONT_FACES, sliceFile } = await import(
  join(api, 'dist/services/documents/pdf-font-faces.js')
);
const require = createRequire(join(api, 'package.json'));
const KEEP = new Set(['LICENSE', 'package.json', 'unicode.json', 'metadata.json', 'index.css']);

let kept = 0;
let removed = 0;
for (const id of new Set(PDF_FONT_FACES.map((face) => face.id))) {
  let dir;
  try {
    dir = realpathSync(dirname(require.resolve(`@fontsource/${id}`)));
  } catch {
    console.warn(`@fontsource/${id} is not installed; PDFs fall back for its scripts.`);
    continue;
  }
  const { default: unicode } = await import(join(dir, 'unicode.json'), { with: { type: 'json' } });
  const files = new Set();
  for (const face of PDF_FONT_FACES.filter((candidate) => candidate.id === id))
    for (const subset of face.subsets ?? Object.keys(unicode))
      for (const weight of face.weights)
        for (const italic of face.italic ? [false, true] : [false])
          files.add(sliceFile(id, subset, weight, italic));
  const visit = (path, relative) => {
    const stat = statSync(path);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path)) visit(join(path, name), join(relative, name));
      return;
    }
    const keep =
      KEEP.has(relative) || (relative.startsWith('files/') && files.has(relative.slice(6)));
    if (keep) kept += stat.size;
    else {
      removed += stat.size;
      if (!dryRun) rmSync(path);
    }
  };
  for (const name of readdirSync(dir)) visit(join(dir, name), name);
}
const mb = (bytes) => `${(bytes / 1024 ** 2).toFixed(1)} MB`;
console.log(`PDF fonts: kept ${mb(kept)}, ${dryRun ? 'would remove' : 'removed'} ${mb(removed)}.`);
