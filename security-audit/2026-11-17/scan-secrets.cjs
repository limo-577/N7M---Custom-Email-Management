// Read-only local evidence. Never write matched credential values to a report.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const git = args => execFileSync('git', args, { cwd: root, windowsHide: true, maxBuffer: 128 * 1024 * 1024 });
const signatures = {
  privateKey: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
  aws: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  github: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/,
  apiKey: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{40,}\b/,
  slack: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  webhook: /https:\/\/(?:hooks\.slack\.com\/services|discord(?:app)?\.com\/api\/webhooks)\/[^\s"'<>]+/,
  database: /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis):\/\/[^\s"'<>]+:[^\s"'<>]+@/
};
const findings = [], current = new Set();
function inspect(bytes, scope, file) {
  const source = bytes.toString('utf8');
  for (const [kind, expression] of Object.entries(signatures)) if (expression.test(source)) findings.push({ scope, file, kind });
}
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || (entry.isDirectory() && ['node_modules', '.git'].includes(entry.name))) continue;
    const full = path.join(dir, entry.name), file = path.relative(root, full).replaceAll('\\', '/');
    if (entry.isDirectory()) walk(full);
    else if (!/\.(?:exe|dll|pdb|bin|dat|pak|png|jpe?g|ico|pdf|tgz|zip|7z|asar|woff2?|ttf|mp4|webm|blockmap)$/i.test(entry.name) && fs.statSync(full).size < 32 * 1024 * 1024) current.add(file);
  }
}
walk(root);
for (const file of current) inspect(fs.readFileSync(path.join(root, file)), 'working-tree-and-text-artifacts', file);
const tracked = git(['ls-files', '-z']).toString().split('\0').filter(Boolean);
const objects = git(['rev-list', '--objects', '--all']).toString().trim().split('\n');
let historyBlobs = 0;
for (const line of objects) {
  const at = line.indexOf(' '); if (at < 0) continue;
  const oid = line.slice(0, at), file = line.slice(at + 1);
  if (!/\.(?:cjs|mjs|js|jsx|json|md|txt|log|csv|tsv|ya?ml|html|css|nsi|env|pem|key)$|(?:^|\/)\.env(?:\.|$)|(?:^|\/)\.gitignore$/.test(file)) continue;
  if (git(['cat-file', '-t', oid]).toString().trim() !== 'blob') continue;
  inspect(git(['cat-file', 'blob', oid]), 'local-git-history', file); historyBlobs++;
}
let asarFiles = 0;
const asarPath = path.join(root, 'release/win-unpacked/resources/app.asar');
if (fs.existsSync(asarPath)) {
  const asar = require('@electron/asar');
  for (const entry of asar.listPackage(asarPath)) {
    const file = entry.replace(/^[/\\]+/, '').replaceAll('\\', '/');
    if (/^(?:electron|src|dist)\//.test(file) && /\.(?:cjs|mjs|js|jsx|html|css|json)$/.test(file)) {
      inspect(asar.extractFile(asarPath, file.replaceAll('/', path.sep)), 'existing-release-asar', file); asarFiles++;
    }
  }
}
const result = {
  auditDate: '2026-11-17', head: git(['rev-parse', 'HEAD']).toString().trim(),
  workingTreeTextFiles: current.size, historyTextBlobs: historyBlobs, existingReleaseAsarTextFiles: asarFiles,
  trackedSensitivePaths: tracked.filter(file => /(?:^|\/)\.env(?:\.|$)|\.(?:pem|key|p12|pfx)$|(?:^|\/)email-(?:data|vault)\.json/.test(file)),
  ignoredPaths: Object.fromEntries(['.env', '.env.local', 'sample.key', 'sample.pem', 'sample.pfx', 'email-data.json', 'email-vault.json', '.env.example'].map(file => {
    let ignored = false; try { git(['check-ignore', '-q', '--no-index', file]); ignored = true; } catch {} return [file, ignored];
  })), findings,
  limits: 'Signature scan and manual review; no secret values saved. Local Git refs only. Build text and application ASAR reviewed; encrypted/compressed executables and third-party binaries not reverse-engineered. Test fixture passwords are not classified as production credentials.'
};
fs.writeFileSync(path.join(__dirname, 'secret-scan.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));