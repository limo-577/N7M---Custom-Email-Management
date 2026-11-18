const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json')));
const packages = Object.entries(lock.packages).filter(([key]) => key).map(([key, value]) => ({
  path: key, name: value.name || key.split('node_modules/').at(-1), version: value.version,
  dev: !!value.dev, deprecated: value.deprecated || null, resolved: value.resolved, integrity: value.integrity
}));
const direct = Object.entries({ runtime: pkg.dependencies, development: pkg.devDependencies }).flatMap(([kind, entries]) => Object.entries(entries).map(([name, declared]) => {
  const installed = packages.find(value => value.path === `node_modules/${name}`);
  return { name, kind, declared, actual: installed.version, actualName: installed.name, resolved: installed.resolved, integrity: installed.integrity };
}));
fs.writeFileSync(path.join(__dirname, 'dependencies.json'), JSON.stringify({ auditDate: '2026-11-17', projectVersion: pkg.version, directCount: direct.length, lockEntries: packages.length, direct, packages }, null, 2) + '\n');
const files = [];
function walk(relative) {
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const file = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (/\.(?:cjs|mjs|js|jsx|css|ps1|nsi|yml|yaml|json|html)$/.test(file)) files.push(file);
  }
}
for (const dir of ['src', 'electron', 'build', '.github', 'vendor/minimatch-compat', 'tests']) walk(dir);
files.push('README.md', '.gitignore', 'package.json', 'package-lock.json', 'vite.config.js', 'playwright.config.mjs', 'tailwind.config.js', 'postcss.config.js', 'index.html');
const manifest = files.sort().map(file => { const bytes = fs.readFileSync(path.join(root, file)); return { file, bytes: bytes.length, lines: bytes.toString().split('\n').length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }; });
fs.writeFileSync(path.join(__dirname, 'scope-manifest.json'), JSON.stringify({ date: '2026-11-17', head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim(), workingTreeModified: true, files: manifest }, null, 2) + '\n');
console.log(JSON.stringify({ version: pkg.version, direct: direct.length, lockEntries: packages.length, reviewedFiles: manifest.length, deprecated: packages.filter(value => value.deprecated).map(value => ({ name: value.name, version: value.version })) }));