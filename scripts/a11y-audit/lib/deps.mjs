/**
 * Playwright and axe come from the web app's dev dependencies (apps/web/package.json): the
 * audit adds no dependency of its own, and `scripts/` has no node_modules to resolve them from.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from './routes.mjs';

const fromWeb = createRequire(join(REPO_ROOT, 'apps', 'web', 'package.json'));

function packageVersion(entry) {
  let directory = dirname(realpathSync(entry));
  for (let i = 0; i < 6; i += 1) {
    try {
      const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
      if (manifest.name) return manifest.version;
    } catch {
      // Not here: look one level up.
    }
    directory = dirname(directory);
  }
  return 'unknown';
}

/** @returns {Promise<{ playwright: any, AxeBuilder: any, versions: Record<string, string> }>} */
export async function loadTools() {
  const playwright = fromWeb('@playwright/test');
  const axePlaywright = fromWeb.resolve('@axe-core/playwright');
  const { AxeBuilder } = await import(pathToFileURL(axePlaywright).href);
  const axeCore = createRequire(realpathSync(axePlaywright)).resolve('axe-core');
  return {
    playwright,
    AxeBuilder,
    versions: {
      '@playwright/test': packageVersion(fromWeb.resolve('@playwright/test')),
      '@axe-core/playwright': packageVersion(axePlaywright),
      'axe-core': packageVersion(axeCore),
    },
  };
}
