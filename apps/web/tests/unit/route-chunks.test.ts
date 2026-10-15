import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';

const checker = fileURLToPath(new URL('../../scripts/check-route-chunks.mjs', import.meta.url));
const dirs: string[] = [];
function fixture(source: string, dynamic = false) {
  const dir = mkdtempSync(join(tmpdir(), 'oci-route-chunks-'));
  dirs.push(dir);
  mkdirSync(join(dir, '.vite'));
  writeFileSync(
    join(dir, '.vite/manifest.json'),
    JSON.stringify({
      'index.html': {
        isEntry: true,
        file: 'entry.js',
        imports: ['shared'],
        dynamicImports: ['lazy'],
      },
      shared: { file: 'shared.js', imports: ['index.html', ...(dynamic ? [] : ['lazy'])] },
      lazy: { file: 'lazy.js' },
    }),
  );
  for (const [file, sources] of Object.entries({
    'entry.js': ['../../src/main.tsx'],
    'shared.js': ['../../src/lib/utils.ts'],
    'lazy.js': [source],
  })) {
    writeFileSync(join(dir, file), 'export {};');
    writeFileSync(join(dir, `${file}.map`), JSON.stringify({ sources }));
  }
  return dir;
}
const check = (dir: string) => spawnSync(process.execPath, [checker, dir], { encoding: 'utf8' });
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it('allows deferred imports and terminates static dependency cycles', () => {
  const result = check(fixture('../../src/routes/admin/health.tsx', true));
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('2 initial JS files');
});

it.each([
  '../../src/routes/admin/health.tsx',
  '../../src/routes/settings/models.tsx',
  '../../src/components/admin/admin-layout.tsx',
  '../../src/components/settings/settings-layout.tsx',
])('rejects a protected route source nested in shared static chunks: %s', (source) => {
  const result = check(fixture(source));
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Deferred route code leaked into initial JavaScript');
  expect(result.stderr).toContain(source);
});

// Every message catalog, English included, is its own lazily loaded chunk
// (v0.14, #397): about a thousand strings would not fit in the initial budget.
it.each(['../../src/locales/en.json', '../../src/locales/es.json', '../../src/locales/ar.json'])(
  'rejects a message catalog in the initial JavaScript: %s',
  (source) => {
    const result = check(fixture(source));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Message catalog in the initial JavaScript');
    expect(result.stderr).toContain(source);
  },
);

it('allows the catalogs as lazy chunks and the registry (locales/index.ts) in the entry', () => {
  expect(check(fixture('../../src/locales/en.json', true)).status).toBe(0);
  expect(check(fixture('../../src/locales/index.ts')).status).toBe(0);
});

it('does not silently pass incomplete source mapping evidence', () => {
  const dir = fixture('../../src/routes/admin/health.tsx', true);
  rmSync(join(dir, 'shared.js.map'));
  const result = check(dir);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('shared.js.map');
});
