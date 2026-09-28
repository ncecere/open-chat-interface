import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

// Check the actual production graph, not just import syntax in router.tsx.
// Shared imports (for example the command palette) can defeat a lazy boundary.
const dist = process.argv[2] ?? fileURLToPath(new URL('../dist/', import.meta.url));
const json = (path) => JSON.parse(readFileSync(resolve(dist, path), 'utf8'));
const manifest = json('.vite/manifest.json');
if (!manifest['index.html']?.isEntry) throw new Error('Missing application entry in Vite manifest');
const deferred =
  /(?:^|\/)src\/(?:routes\/(?:admin|settings)\/|components\/(?:admin\/admin-layout|settings\/settings-layout)\.tsx$)/;
const visited = new Set();
const files = new Set();
const violations = new Set();
function visit(key) {
  if (visited.has(key)) return;
  visited.add(key);
  const chunk = manifest[key];
  if (!chunk) throw new Error(`Missing manifest chunk: ${key}`);
  files.add(chunk.file);
  // Vite/Rolldown emit these two generated helpers without source maps.
  // Every source-bearing chunk must still be mapped and checked.
  const generatedHelper = !chunk.src && ['rolldown-runtime', 'preload-helper'].includes(chunk.name);
  if (!generatedHelper || existsSync(resolve(dist, `${chunk.file}.map`))) {
    const map = json(`${chunk.file}.map`);
    if (!Array.isArray(map.sources) || !map.sources.length)
      throw new Error(`Missing source mappings: ${chunk.file}`);
    for (const source of map.sources) {
      if (deferred.test(source.replaceAll('\\', '/'))) violations.add(source);
    }
  }
  // Deliberately do not traverse dynamicImports: they are deferred downloads.
  for (const dependency of chunk.imports ?? []) visit(dependency);
}
visit('index.html');
if (violations.size)
  throw new Error(
    `Deferred route code leaked into initial JavaScript:\n${[...violations].join('\n')}`,
  );
let bytes = 0;
let gzipBytes = 0;
for (const file of files) {
  const content = readFileSync(resolve(dist, file));
  bytes += content.length;
  gzipBytes += gzipSync(content).length;
}
console.log(
  `Route chunk boundary passed: ${files.size} initial JS files, ${bytes} bytes (${gzipBytes} gzip bytes). Not a browser-latency measurement.`,
);
