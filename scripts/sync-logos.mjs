#!/usr/bin/env node
/**
 * Syncs model-lab logos from the logos S3 bucket into the web app.
 *
 * Copies only the base mark for each vendor (the folder-named variant, not the
 * `-text`/`-color` wordmarks) in SVG, verifies every file against the bucket
 * manifest's SHA-256, then regenerates `packages/shared/src/model-labs.ts`.
 *
 *   node scripts/sync-logos.mjs [--config ~/.config/s3cmd/rustfs.s3cfg]
 *
 * Requires the `s3cmd` CLI. Display names live in `scripts/lab-names.json` so a
 * resync never clobbers curated capitalization.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');

const configFlagIndex = process.argv.indexOf('--config');
const s3Config =
  configFlagIndex === -1
    ? join(process.env.HOME ?? '', '.config/s3cmd/rustfs.s3cfg')
    : process.argv[configFlagIndex + 1];

const BUCKET = 's3://logos';
const PUBLIC_DIR = join(repoRoot, 'apps/web/public/logos');
const CATALOG_FILE = join(repoRoot, 'packages/shared/src/model-labs.ts');
const NAMES_FILE = join(scriptDir, 'lab-names.json');

function s3(args) {
  return execFileSync('s3cmd', ['-c', s3Config, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

function titleCase(folder) {
  return folder.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

const work = mkdtempSync(join(tmpdir(), 'oci-logos-'));
try {
  console.log('Fetching manifest...');
  s3(['get', '--force', `${BUCKET}/_catalog/manifest.json`, join(work, 'manifest.json')]);
  const manifest = JSON.parse(readFileSync(join(work, 'manifest.json'), 'utf8'));

  // The base mark is the variant named after its folder; skip wordmark variants.
  const base = manifest.assets.filter((a) => a.format === 'svg' && a.variant === a.folder);
  console.log(`Syncing ${base.length} SVG marks...`);

  const svgDir = join(work, 'svg');
  mkdirSync(svgDir, { recursive: true });
  s3(['sync', '--exclude', '*', '--include', '*.svg', `${BUCKET}/`, `${svgDir}/`]);

  rmSync(PUBLIC_DIR, { recursive: true, force: true });
  mkdirSync(PUBLIC_DIR, { recursive: true });

  const mismatched = [];
  for (const asset of base) {
    const src = join(svgDir, asset.key);
    if (!existsSync(src)) {
      mismatched.push(`${asset.key} (missing)`);
      continue;
    }
    const digest = createHash('sha256').update(readFileSync(src)).digest('hex');
    if (digest !== asset.sha256) {
      mismatched.push(`${asset.key} (checksum)`);
      continue;
    }
    const dest = join(PUBLIC_DIR, asset.key);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest);
  }

  if (mismatched.length > 0) {
    throw new Error(
      `Refusing to continue; ${mismatched.length} assets failed verification:\n  ${mismatched.join('\n  ')}`,
    );
  }

  // Attribution travels with the assets.
  s3(['get', '--force', `${BUCKET}/_sources/lobehub/LICENSE`, join(PUBLIC_DIR, 'LICENSE')]);
  s3(['get', '--force', `${BUCKET}/_sources/lobehub/SOURCE.json`, join(PUBLIC_DIR, 'SOURCE.json')]);

  const names = JSON.parse(readFileSync(NAMES_FILE, 'utf8'));
  const byFolder = new Map();
  for (const asset of base) {
    const modes = byFolder.get(asset.folder) ?? {};
    modes[asset.mode] = asset.filename;
    byFolder.set(asset.folder, modes);
  }

  const labs = [];
  for (const [folder, modes] of byFolder) {
    // Fixed-color marks are emitted once and reused for both themes.
    const light = modes.light ?? modes.universal;
    const dark = modes.dark ?? modes.universal;
    if (!light || !dark) continue;
    labs.push({
      id: folder,
      name: names[folder] ?? titleCase(folder),
      light: `${folder}/${light}`,
      dark: `${folder}/${dark}`,
    });
  }
  labs.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

  const rows = labs
    .map(
      (lab) =>
        `  { id: '${lab.id}', name: ${JSON.stringify(lab.name)}, light: '${lab.light}', dark: '${lab.dark}' },`,
    )
    .join('\n');

  writeFileSync(
    CATALOG_FILE,
    `/**
 * Model lab catalog.
 *
 * Generated from the LobeHub icon set (MIT). Each entry names a lab and the
 * light/dark SVG marks served from \`/logos\`. Individual company logos may also
 * be governed by their owners' trademark and brand-use policies.
 *
 * Regenerate with \`pnpm logos:sync\`.
 */

export interface ModelLab {
  /** Stable slug persisted on the model row. */
  id: string;
  name: string;
  /** Paths relative to the \`/logos\` static prefix. */
  light: string;
  dark: string;
}

export const MODEL_LABS: readonly ModelLab[] = [
${rows}
] as const;

const LABS_BY_ID = new Map(MODEL_LABS.map((lab) => [lab.id, lab]));

export function findModelLab(id: string | null | undefined): ModelLab | null {
  return id ? (LABS_BY_ID.get(id) ?? null) : null;
}

/** Resolves the public URL for a lab mark in the active theme. */
export function modelLabLogoUrl(lab: ModelLab, mode: 'light' | 'dark'): string {
  return \`/logos/\${mode === 'dark' ? lab.dark : lab.light}\`;
}
`,
  );

  console.log(`Wrote ${labs.length} labs to ${CATALOG_FILE}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
