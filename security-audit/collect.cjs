// Read-only evidence collection. Never print credential values.
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const patterns = {
  privateKey: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
  aws: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  github: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g,
  openai: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{40,}\b/g,
  slack: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
  webhook: /https:\/\/(?:hooks\.slack\.com\/services|discord(?:app)?\.com\/api\/webhooks)\/[^\s"'<>]+/g,
  database: /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis):\/\/[^\s"'<>]+:[^\s"'<>]+@/g
};
const findings = [], files = [], sensitiveFiles = [];
function walk(dir) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'security-audit'].includes(item.name)) continue;
    const file = path.join(dir, item.name);
    if (item.isSymbolicLink()) continue;
    if (item.isDirectory()) { walk(file); continue; }
    const relative = path.relative(root, file);
    if (/^\.env(?:\.|$)|\.(?:pem|key|p12|pfx)$/i.test(item.name)) sensitiveFiles.push(relative);
    files.push(relative);
    const fd = fs.openSync(file, 'r'), buffer = Buffer.alloc(1024 * 1024);
    let carry = '', length;
    try {
      while ((length = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
        const source = carry + buffer.subarray(0, length).toString('utf8');
        for (const [kind, regex] of Object.entries(patterns)) {
          regex.lastIndex = 0;
          if (regex.test(source) && !findings.some(v => v.file === relative && v.kind === kind)) findings.push({ file: relative, kind });
        }
        carry = source.slice(-1024);
      }
    } finally { fs.closeSync(fd); }
  }
}
walk(root);
fs.writeFileSync(path.join(__dirname, 'secret-scan.json'), JSON.stringify({
  note: 'Pattern scan of raw bytes, including dist, release and test-results. Compressed/encrypted contents and historical Git objects are not decoded; no credential values are recorded.',
  filesScanned: files.length, sensitiveFiles, findings, files
}, null, 2));
console.log(JSON.stringify({ filesScanned: files.length, sensitiveFiles, findings }));
