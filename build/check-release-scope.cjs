'use strict';
// Read the exact staged blobs. Never log matched credential values.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const git = (args, input) => execFileSync('git', args, { cwd: root, input, windowsHide: true, maxBuffer: 128 * 1024 * 1024 });
const signatures = {
  privateKey: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
  githubToken: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/,
  awsAccessKey: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  apiKey: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{40,}\b/,
  serviceToken: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  authenticatedDatabase: /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis):\/\/[^\s"'<>]+:[^\s"'<>]+@/
};
function main() {
  const reportFile = path.resolve(process.argv[2] || '.risk-build/release-scope.json');
  if (!reportFile.startsWith(path.join(root, '.risk-build') + path.sep)) throw Error('Report must be under .risk-build/');
  const entries = git(['ls-files', '--stage', '-z']).toString('utf8').split('\0').filter(Boolean).map(line => {
    const match = /^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(line);
    if (!match || match[3] !== '0') throw Error('Unmerged or unsupported index');
    return { mode: match[1], oid: match[2], file: match[4] };
  });
  const findings = [];
  for (const entry of entries) {
    if (!['100644', '100755'].includes(entry.mode)) findings.push({ file: entry.file, kind: 'link-or-special-entry' });
    if (/^(?:\.risk-build|test-results|release|dist|out|output|node_modules)\//i.test(entry.file) ||
      /(?:^|\/)(?:\.env(?:\..*)?|email-(?:data|vault)\.json.*|authorization\.json|[^/]+\.(?:consumed|revoked)\.json)$/i.test(entry.file) && !/(?:^|\/)\.env\.example$/.test(entry.file) ||
      /\.(?:pem|key|pfx|p12|exe|dll|zip|7z|asar|blockmap)$/i.test(entry.file)) findings.push({ file: entry.file, kind: 'excluded-release-or-sensitive-path' });
  }
  const unique = [...new Set(entries.map(entry => entry.oid))];
  const batch = git(['cat-file', '--batch'], unique.join('\n') + '\n');
  let cursor = 0;
  const byOid = new Map();
  for (const oid of unique) {
    const end = batch.indexOf(10, cursor); const header = batch.subarray(cursor, end).toString();
    const match = /^([a-f0-9]+) blob (\d+)$/.exec(header);
    if (!match || match[1] !== oid) throw Error('Cannot read staged blob');
    const size = Number(match[2]), bytes = batch.subarray(end + 1, end + 1 + size); cursor = end + size + 2;
    const text = bytes.toString('utf8'), kinds = [];
    for (const [kind, expression] of Object.entries(signatures)) if (expression.test(text)) kinds.push(kind);
    if (/^\s*\{/.test(text)) {
      try { const value = JSON.parse(text); if (value?.statement && value?.signature) kinds.push('signed-authorization-envelope'); } catch { /* Not JSON metadata. */ }
    }
    byOid.set(oid, kinds);
  }
  for (const entry of entries) for (const kind of byOid.get(entry.oid)) findings.push({ file: entry.file, kind });
  const result = { checkedAt: new Date().toISOString(), scope: 'Exact complete Git index; no credential values included.', indexedFiles: entries.length, uniqueBlobs: unique.length, findings,
    limits: 'Pattern and path scan plus submission review, not a guarantee against obfuscated secrets or compressed/binary content. Public test vectors are not production credentials.' };
  fs.mkdirSync(path.dirname(reportFile), { recursive: true }); fs.writeFileSync(reportFile, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ indexedFiles: entries.length, findings: findings.length })); process.exitCode = findings.length ? 1 : 0;
}
if (require.main === module) { try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
