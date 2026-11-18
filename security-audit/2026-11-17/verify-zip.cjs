'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const JSZip = require('jszip');
const root = path.resolve(__dirname, '../..');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
(async () => {
  const archive = path.join(root, 'release/N7M - Custom Email Management-1.8.0-NoInstall.zip');
  const zip = await JSZip.loadAsync(fs.readFileSync(archive));
  const results = [];
  for (const file of ['resources/app.asar', 'N7M - Custom Email Management.exe']) {
    const entry = zip.file(file); assert.ok(entry, 'Missing ZIP entry: ' + file);
    const zipped = hash(await entry.async('nodebuffer'));
    const unpacked = hash(fs.readFileSync(path.join(root, 'release/win-unpacked', file)));
    assert.equal(zipped, unpacked, 'ZIP/unpacked mismatch: ' + file);
    results.push({ file, sha256: zipped });
  }
  fs.writeFileSync(path.join(__dirname, 'zip-verification.json'), JSON.stringify({ matches: results }, null, 2));
  console.log(JSON.stringify(results));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
