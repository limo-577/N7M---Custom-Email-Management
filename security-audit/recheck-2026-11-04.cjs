const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const git = args => execFileSync('git', args, { cwd: root, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
const patterns = {
  privateKey: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
  aws: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  github: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/,
  openai: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{40,}\b/,
  slack: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  webhook: /https:\/\/(?:hooks\.slack\.com\/services|discord(?:app)?\.com\/api\/webhooks)\/[^\s"'<>]+/,
  database: /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis):\/\/[^\s"'<>]+:[^\s"'<>]+@/
};
function inspect(bytes, scope, file, findings) {
  const source = bytes.toString('utf8');
  for (const [kind, expression] of Object.entries(patterns)) if (expression.test(source)) findings.push({ scope, file, kind });
}
const tracked = git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).toString('utf8').split('\0').filter(Boolean);
const current = tracked.filter(file => !/\.(?:png|ico|tgz|zip|exe)$/i.test(file));
function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (/\.(?:html|js|css|map|json)$/i.test(entry.name)) current.push(path.relative(root, file));
  }
}
walk(path.join(root, 'dist'));
const findings = [];
for (const file of current) inspect(fs.readFileSync(path.join(root, file)), 'current', file, findings);
const historicalPaths = new Set();
for (const commit of git(['rev-list', '--all']).toString().trim().split('\n')) {
  for (const file of git(['ls-tree', '-r', '--name-only', commit]).toString().trim().split('\n')) if (file.startsWith('test-results/')) historicalPaths.add(file);
}
const history = git(['rev-list', '--objects', '--all']).toString('utf8').trim().split('\n').map(line => {
  const at = line.indexOf(' '); return { oid: line.slice(0, at), file: line.slice(at + 1) };
}).filter(value => value.oid && /\.(?:cjs|mjs|js|jsx|json|md|txt|log|csv|tsv|ya?ml|html|css|nsi|env)$|(?:^|\/)\.env(?:\.|$)|(?:^|\/)\.gitignore$/.test(value.file));
let historyBlobs = 0;
for (const { oid, file } of history) {
  const type = git(['cat-file', '-t', oid]).toString().trim();
  if (type !== 'blob') continue;
  inspect(git(['cat-file', 'blob', oid]), 'history', file, findings); historyBlobs++;
}
const evidence = {
  date: '2026-11-04', head: git(['rev-parse', 'HEAD']).toString().trim(),
  currentFiles: current.length, historyTextBlobs: historyBlobs,
  trackedSensitiveFiles: tracked.filter(file => /(?:^|\/)\.env(?:\.|$)|\.(?:pem|key|p12|pfx)$|(?:^|\/)email-(?:data|vault)\.json/.test(file)),
  historicalTestArtifactPaths: historicalPaths.size,
  findings,
  limits: 'High-confidence raw-text credential signatures only; excludes compressed/encrypted content, binary reverse engineering and remote-only Git refs. Test fixtures are not automatically classified as live credentials. No credential values are saved.'
};
fs.writeFileSync(path.join(__dirname, 'secret-scan-current.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence));
