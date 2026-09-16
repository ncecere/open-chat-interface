#!/usr/bin/env node
/**
 * A review aid, not a complexity/conformance gate. Long data tables and JSX are
 * legitimate; the report identifies places to read rather than prescribing a
 * line limit or claiming that a short module is well designed.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const sourceRoots = ['apps/api/src', 'apps/web/src', 'packages/db/src', 'packages/shared/src'];
const files = [];
const functions = [];
const routeDependencies = [];

function visitDirectory(directory) {
  for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const name = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!['__tests__', 'node_modules', 'dist'].includes(entry.name)) visitDirectory(name);
    } else if (/\.tsx?$/.test(name) && !/\.(?:d|test|spec)\.tsx?$/.test(name)) {
      inspectFile(name);
    }
  }
}

function inspectFile(file) {
  const text = readFileSync(path.join(root, file), 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const lines = text.trimEnd().split('\n').length;
  let functionCount = 0;

  function visit(node) {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node)
    ) {
      functionCount++;
      const start = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      const end = source.getLineAndCharacterOfPosition(node.end).line + 1;
      if (end - start + 1 >= 150) {
        const parent = node.parent;
        const name =
          node.name?.getText(source) ??
          (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent)
            ? parent.name.getText(source)
            : 'callback');
        functions.push({ file, name, start, end, lines: end - start + 1 });
      }
    }
    if (
      file.startsWith('apps/api/src/routes/') &&
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const specifier = node.moduleSpecifier.text;
      if (specifier.startsWith('.')) {
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
        // Route composition indexes legitimately mount subrouters. A leaf
        // handler importing a sibling often indicates a misplaced service.
        if (resolved.startsWith('apps/api/src/routes/') && !file.endsWith('/index.ts')) {
          routeDependencies.push({ file, imports: specifier });
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  files.push({ file, lines, functionCount });
}

for (const directory of sourceRoots) visitDirectory(directory);
const report = {
  scannedFiles: files.length,
  largeFiles: files.filter((file) => file.lines >= 400).sort((a, b) => b.lines - a.lines),
  longFunctions: functions.sort((a, b) => b.lines - a.lines),
  routeDependencies,
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`Scanned ${report.scannedFiles} source files (tests and declarations excluded).`);
  console.log('\nFiles >=400 lines — inspect cohesion, not just size:');
  for (const file of report.largeFiles) {
    console.log(`  ${file.lines} lines  ${file.file} (${file.functionCount} function nodes)`);
  }
  console.log('\nFunctions/components >=150 lines — includes JSX and callbacks:');
  for (const fn of report.longFunctions) {
    console.log(`  ${fn.lines} lines  ${fn.file}:${fn.start}-${fn.end}  ${fn.name}`);
  }
  console.log('\nLeaf API routes importing routes (composition indexes excluded):');
  for (const entry of report.routeDependencies) console.log(`  ${entry.file} -> ${entry.imports}`);
  if (!report.routeDependencies.length) console.log('  None.');
}
