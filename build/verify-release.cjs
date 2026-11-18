'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const asar = require('@electron/asar');
const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const value = name => args[args.indexOf(name) + 1];
if (args.length !== 4 || !args.includes('--output') || !args.includes('--report')) throw Error('Usage: verify-release.cjs --output DIRECTORY --report FILE');
const output = path.resolve(value('--output'));
const report = path.resolve(value('--report'));
if (!output.startsWith(path.join(root, 'release') + path.sep)) throw Error('Output must be under release/');
if (!report.startsWith(path.join(root, '.risk-build') + path.sep)) throw Error('Report must be under .risk-build/');
if (fs.existsSync(report)) throw Error('Refuse to overwrite artifact evidence');
fs.mkdirSync(path.dirname(report), { recursive: true });
const manifest = require('../package.json');
const lock = require('../package-lock.json');
const sevenZip = path.join(process.env.ProgramFiles || 'C:/Program Files', '7-Zip/7z.exe');
const scratch = fs.mkdtempSync(path.join(path.dirname(report), 'artifact-check-'));
fs.mkdirSync(scratch, { recursive: true });
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const prohibitedPackagePath = value => /(?:^|\/)node_modules\/(?:picomatch|vite|tailwindcss|electron-builder|exceljs)(?:\/|$)|\/exceljs-hardened\/dist\//i.test(value.replaceAll('\\', '/'));
function inspectArchive(archive) {
  const listing = spawnSync(sevenZip, ['l', '-slt', '-ba', archive], { windowsHide: true, encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(listing.error, undefined, 'Archive listing failed');
  assert.equal(listing.status, 0, listing.stderr);
  const paths = listing.stdout.split(/\r?\n/).filter(line => line.startsWith('Path = ')).map(line => line.slice(7));
  assert.ok(paths.length > 0, 'Archive has no readable payload entries');
  assert.ok(!paths.some(prohibitedPackagePath), 'Forbidden development package outside ASAR in final archive');
  return paths.length;
}
async function fileHash(file) {
  const digest = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}
function extract(archive, entry, destination) {
  return new Promise((resolve, reject) => {
    const digest = crypto.createHash('sha256');
    const child = spawn(sevenZip, ['e', '-so', archive, entry], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
    let stderr = '';
    const stream = destination ? fs.createWriteStream(destination) : null;
    let bytes = 0;
    child.stdout.on('data', chunk => { digest.update(chunk); bytes += chunk.length; });
    if (stream) child.stdout.pipe(stream);
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      const finish = () => code === 0 && bytes > 0 ? resolve({ bytes, sha256: digest.digest('hex') }) : reject(Error(`7-Zip ${code}: ${stderr}`));
      if (stream && !stream.writableFinished) stream.once('finish', finish); else finish();
    });
  });
}
async function main() {
  // Check loose resources too: asarUnpack must not hide forbidden dev modules.
  function inspectLoose(directory, relative = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const name = `${relative}/${entry.name}`;
      assert.ok(!entry.isSymbolicLink(), 'Payload links are not accepted');
      assert.ok(!prohibitedPackagePath(name), `Forbidden loose runtime package: ${name}`);
      if (entry.isDirectory()) inspectLoose(path.join(directory, entry.name), name);
    }
  }
  inspectLoose(path.join(output, 'win-unpacked'));
  const archive = path.join(output, 'win-unpacked/resources/app.asar');
  const read = file => asar.extractFile(archive, file.replaceAll('/', path.sep));
  const packaged = JSON.parse(read('package.json'));
  for (const key of ['name', 'version', 'main', 'type', 'dependencies', 'overrides']) assert.deepEqual(packaged[key], manifest[key], `Packaged manifest: ${key}`);
  const sourceFiles = ['src/model.mjs', 'src/mutations.mjs'];
  function visit(directory) {
    for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) visit(file); else sourceFiles.push(file);
    }
  }
  visit('dist'); visit('electron');
  for (const file of sourceFiles) assert.ok(read(file).equals(fs.readFileSync(path.join(root, file))), `Source mismatch: ${file}`);
  const names = asar.listPackage(archive).map(file => file.replaceAll('\\', '/'));
  assert.ok(!names.some(prohibitedPackagePath), 'Unexpected development/old ExcelJS/browser bundle in payload');
  const runtimePackages = names.filter(file => /\/node_modules\/.*\/package.json$/.test(file)).flatMap(file => {
    const data = JSON.parse(read(file.slice(1)));
    // Some modules ship fixture or other metadata named package.json.
    if (!data.name || !data.version) return [];
    const matches = Object.entries(lock.packages).filter(([key, value]) => key && !value.dev &&
      (value.name || key.split('node_modules/').at(-1)) === data.name && value.version === data.version);
    assert.ok(matches.length, `Unreviewed runtime dependency ${data.name}@${data.version}`);
    return [{ name: data.name, version: data.version }];
  });
  assert.ok(runtimePackages.some(value => value.name === 'exceljs-hardened' && value.version === '5.1.1'));
  assert.ok(runtimePackages.some(value => value.name === '@n7m/minimatch-compat' && value.version === '1.0.2'));
  assert.ok(runtimePackages.some(value => value.name === 'minimatch' && value.version === '11.0.9'));
  const checks = [];
  const exe = `${manifest.build.productName}.exe`;
  const expected = Object.fromEntries(await Promise.all(['resources/app.asar', exe].map(async file => [file, await fileHash(path.join(output, 'win-unpacked', file))])));
  for (const kind of ['Setup.exe', 'Portable.exe', 'NoInstall.zip']) {
    const file = `${manifest.build.productName}-${manifest.version}-${kind}`;
    const artifact = path.join(output, file);
    assert.ok(fs.statSync(artifact).size > 1000000);
    const outerEntries = inspectArchive(artifact);
    let payload = artifact;
    if (kind === 'Setup.exe') {
      payload = path.join(scratch, 'setup-app-64.7z');
      await extract(artifact, '$PLUGINSDIR/app-64.7z', payload);
      inspectArchive(payload);
    }
    const contents = [];
    for (const entry of ['resources/app.asar', exe]) {
      const value = await extract(payload, entry);
      assert.equal(value.sha256, expected[entry], `${kind}: ${entry}`);
      contents.push({ entry, ...value });
    }
    checks.push({ file, bytes: fs.statSync(artifact).size, sha256: await fileHash(artifact), outerEntries, contents });
  }
  const result = { version: manifest.version, releaseEligible: false,
    reason: 'Static payload verification only. Any risk acceptance and publication approval are separate; CVE-2026-112366 is unresolved.',
    sourceFilesMatched: sourceFiles.length, runtimePackages, excludedDevelopmentMatchers: true,
    excludedOldExceljsAndBrowserBundle: true, method: 'Static archive extraction; installer was not executed.', artifacts: checks };
  fs.writeFileSync(report, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ sourceFilesMatched: sourceFiles.length, runtimePackages: runtimePackages.length, artifacts: checks.map(value => ({file: value.file, sha256: value.sha256})), releaseEligible: false }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
