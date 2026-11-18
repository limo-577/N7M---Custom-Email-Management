'use strict';
const fs = require('node:fs');
const file = 'security-audit/dependency-policy.json';
const policy = JSON.parse(fs.readFileSync(file, 'utf8'));
policy.acceptedOn = '2026-11-17';
policy.decision = 'Developer approved migration to unofficial exceljs-hardened 5.1.1 after compatibility and security evaluation. Five deprecated indirect packages remain accepted until the unchanged review deadline. Fork supply-chain and maintenance risks remain explicit.';
policy.deprecatedExceptions = policy.deprecatedExceptions.filter(item => !item.path.endsWith('/fstream'));
for (const item of policy.deprecatedExceptions) {
  if (item.path.endsWith('/glob')) item.reason = 'Build-time ASAR 3 uses legacy glob 7, with patched minimatch 11.0.9 via the CommonJS compatibility adapter.';
  if (item.path.endsWith('/rimraf')) item.reason = 'Build-time electron-winstaller -> temp uses the legacy callback API; no arbitrary renderer deletion operation is exposed.';
  if (item.path.endsWith('/lodash.isequal')) item.reason = 'exceljs-hardened -> fast-csv 4 retains this helper. Application CSV operations use the reviewed application parser/exporter.';
}
policy.protectedPackages = policy.protectedPackages.filter(item => item.name !== 'uuid');
const workbookPin = policy.protectedPackages.find(item => ['exceljs', 'exceljs-hardened'].includes(item.name));
workbookPin.name = 'exceljs-hardened';
policy.protectedPackages.find(item => item.name === 'exceljs-hardened').versions = ['5.1.1'];
delete policy.manifestPins['dependencies.exceljs']; delete policy.manifestPins['overrides.uuid'];
policy.manifestPins['dependencies.exceljs-hardened'] = '5.1.1';
Object.assign(policy.exceljsMaintenance, { package: 'exceljs-hardened', acceptedVersion: '5.1.1', registryEndpoint: 'https://registry.npmjs.org/exceljs-hardened/latest',
  sources: ['https://github.com/mateocallec/exceljs-hardened', 'https://github.com/mateocallec/exceljs-hardened/security/advisories'],
  risk: 'Unofficial unaffiliated fork explicitly approved by the developer. Short maintenance history and supply-chain trust remain risks. Deprecated indirect helpers are not declared maintained.' });
policy.exceljsMaintenance.controls = policy.exceljsMaintenance.controls.map(item => item.replace('Official minimatch and UUID security fixes remain pinned and compatibility-tested.', 'Legacy adapter and modern official minimatch 11.0.9 remain pinned and compatibility-tested.').replace('Node ExcelJS entrypoint', 'Node exceljs-hardened entrypoint'));
fs.writeFileSync(file, JSON.stringify(policy, null, 2) + '\n');
const check = 'build/check-dependencies.cjs';
fs.writeFileSync(check, fs.readFileSync(check, 'utf8').replaceAll('https://registry.npmjs.org/exceljs/latest', 'https://registry.npmjs.org/exceljs-hardened/latest').replace("latest.name !== 'exceljs'", "latest.name !== 'exceljs-hardened'").replaceAll('ExcelJS ', 'exceljs-hardened '));
const test = 'tests/dependency-policy.test.cjs';
fs.writeFileSync(test, fs.readFileSync(test, 'utf8').replace('exactly six', 'exactly five').replace('deprecatedCount, 6', 'deprecatedCount, 5')
  .replaceAll('4.4.0', '5.1.1').replaceAll('4.5.0', '5.2.0').replaceAll("name: 'exceljs'", "name: 'exceljs-hardened'")
  .replaceAll('https://registry.npmjs.org/exceljs/latest', 'https://registry.npmjs.org/exceljs-hardened/latest')
  .replace("manifest.manifest.dependencies.exceljs = '^5.1.1'", "manifest.manifest.dependencies['exceljs-hardened'] = '^5.1.1'")
  .replace('example/node_modules/uuid', 'example/node_modules/minimatch').replace("{ version: '8.3.2' }", "{ version: '10.2.6' }").replace('changed.*uuid', 'changed.*minimatch'));
