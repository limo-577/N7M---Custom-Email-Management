'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const asar = require('@electron/asar');
const root = path.resolve(__dirname, '../..');
const archive = path.join(root, 'release/win-unpacked/resources/app.asar');
const read = file => asar.extractFile(archive, file.split('/').join(path.sep));
// electron-builder removes build/dev-only metadata from the packaged manifest.
const manifest = require('../../package.json'), packagedManifest = JSON.parse(read('package.json'));
for (const key of ['name', 'version', 'main', 'type', 'dependencies', 'overrides']) assert.deepEqual(packagedManifest[key], manifest[key], 'Packaged manifest mismatch: ' + key);
const files = ['src/model.mjs', 'src/mutations.mjs'];
for (const file of fs.readdirSync(path.join(root, 'electron'))) if (/\.(cjs|ps1)$/.test(file)) files.push('electron/' + file);
const visit = directory => {
  for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const name = directory + '/' + entry.name;
    if (entry.isDirectory()) visit(name); else files.push(name);
  }
};
visit('dist');
for (const file of files) assert.ok(read(file).equals(fs.readFileSync(path.join(root, file))), 'Packaged source mismatch: ' + file);
assert.equal(JSON.parse(read('node_modules/exceljs-hardened/package.json')).version, '5.1.1');
const names = asar.listPackage(archive).map(file => file.replaceAll('\\', '/'));
assert.ok(!names.some(file => file.startsWith('/node_modules/exceljs/')));
assert.ok(!names.some(file => file.startsWith('/node_modules/exceljs-hardened/dist/')));
const packages = [];
for (const file of fs.readdirSync(path.join(root, 'release'))) {
  if (!/-1\.8\.0-(?:Setup\.exe|Portable\.exe|NoInstall\.zip)$/.test(file)) continue;
  const bytes = fs.readFileSync(path.join(root, 'release', file));
  packages.push({ file, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
}
assert.equal(packages.length, 3);
const output = { sourceFilesMatched: files.length, forkVersion: '5.1.1', oldExcelJsAbsent: true, browserBundleExcluded: true, packages };
fs.writeFileSync(path.join(__dirname, 'packaged-verification.json'), JSON.stringify(output, null, 2));
console.log(JSON.stringify(output));
