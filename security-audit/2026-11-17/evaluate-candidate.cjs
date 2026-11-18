'use strict';
// Run the unchanged import regression suite against an isolated candidate.
// No production module, dependency manifest or lockfile is replaced.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const root = path.resolve(__dirname, '../..');
const candidate = path.join(root, 'tmp/security-excel-engine/node_modules/exceljs-hardened');
const workerPath = path.join(root, 'tmp/security-excel-engine/xlsx-worker.cjs');
const worker = fs.readFileSync(path.join(root, 'electron/xlsx-worker.cjs'), 'utf8')
  .replace(/require\('exceljs(?:-hardened)?'\)/, `require(${JSON.stringify(candidate)})`);
fs.writeFileSync(workerPath, worker);
const file = path.join(root, 'tests/xlsx.test.cjs');
const suite = new Module(file, module);
suite.filename = file;
suite.paths = Module._nodeModulePaths(path.dirname(file));
const originalRequire = suite.require.bind(suite);
suite.require = name => {
  if (name !== '../electron/xlsx-import.cjs') return originalRequire(name);
  const importer = originalRequire(name);
  return { ...importer, createXlsxImporter: options => importer.createXlsxImporter({ workerPath, ...options }) };
};
suite._compile(fs.readFileSync(file, 'utf8'), file);
