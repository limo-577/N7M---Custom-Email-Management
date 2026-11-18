'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const ADVISORY = 'GHSA-fc5q-39xc-vjpf';
const ACK = 'I accept the unresolved picomatch CVE-2026-112366 for this one build only';
const EXPECTED = Object.freeze({
  'node_modules/picomatch': '2.3.2',
  'node_modules/tinyglobby/node_modules/picomatch': '4.0.7',
  'node_modules/vite/node_modules/picomatch': '4.0.7'
});
const EVIDENCE = Object.freeze([
  'security-audit/2026-11-18/README.md',
  'security-audit/2026-11-18/advisory.json',
  'security-audit/2026-11-18/npm-audit-full.raw.json',
  'security-audit/2026-11-18/audit-full.result.json',
  'security-audit/2026-11-18/candidate-evaluation.json',
  'security-audit/2026-11-18/picomatch-installed-probes.json',
  'security-audit/2026-11-18/artifact-verification.json',
  'security-audit/picomatch-build-inputs.json'
]);
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const stable = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
function requireThat(condition, message) { if (!condition) throw Error(message); }
function safeRelative(value) {
  requireThat(typeof value === 'string' && /^[\p{L}\p{N}_.\-/]+$/u.test(value) && !value.startsWith('/') &&
    value.split('/').every(part => part && part !== '.' && part !== '..'), 'Invalid evidence/source path');
  return value;
}
function timestamp(value) {
  requireThat(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && new Date(value).toISOString() === value, 'Invalid timestamp');
  return Date.parse(value);
}
function checkWindow(statement, now = Date.now()) {
  const start = timestamp(statement.issuedAt), end = timestamp(statement.expiresAt);
  requireThat(end > start && end - start <= 7 * 86400000, 'Acceptance exceeds seven days');
  requireThat(now >= start && now < end, 'Acceptance is not active or has expired');
  requireThat(timestamp(statement.evidenceAt) <= start && start - timestamp(statement.evidenceAt) <= 7 * 86400000, 'Evidence is stale');
}
function inspectAudit(raw, lock) {
  const report = JSON.parse(raw);
  requireThat(report.auditReportVersion === 2 && !report.error && report.vulnerabilities && report.metadata?.vulnerabilities, 'Invalid npm audit report');
  const entries = Object.entries(report.vulnerabilities);
  const roots = new Set(); const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: entries.length };
  for (const [name, value] of entries) {
    requireThat(value.name === name && value.severity === 'high' && Array.isArray(value.via) && value.via.length && Array.isArray(value.nodes) && value.nodes.length, 'Unknown vulnerability or malformed audit entry');
    counts.high++;
    for (const node of value.nodes) requireThat(lock.packages[node]?.dev === true, 'Affected dependency is missing or not development-only');
    for (const via of value.via) {
      if (typeof via === 'string') requireThat(Object.hasOwn(report.vulnerabilities, via), 'Unknown transitive vulnerability');
      else {
        requireThat(via && via.name === 'picomatch' && via.url === `https://github.com/advisories/${ADVISORY}` && via.severity === 'high' && via.range === '<=4.0.7', 'Unknown advisory: exception is picomatch-only');
        requireThat(name === 'picomatch', 'Advisory attached to an unexpected package');
        roots.add(name);
      }
    }
  }
  // The npm report contains parent cycles. Reject rootless cycles, but allow
  // parent cycles that can actually reach the one reviewed advisory.
  const reachesRoot = new Set(roots);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, value] of entries) if (!reachesRoot.has(name) && value.via.some(via => typeof via === 'string' && reachesRoot.has(via))) {
      reachesRoot.add(name); changed = true;
    }
  }
  requireThat(entries.length > 0 && roots.size === 1 && reachesRoot.size === entries.length, 'Unknown or rootless vulnerability chain');
  requireThat(stable(counts) === stable(report.metadata.vulnerabilities), 'Audit severity totals are inconsistent');
  requireThat(stable([...report.vulnerabilities.picomatch.nodes].sort()) === stable(Object.keys(EXPECTED).sort()), 'New or missing picomatch audit path');
  return { count: entries.length, advisory: ADVISORY, rawSha256: sha(raw), vulnerable: true };
}
function checkLock(lock) {
  const found = Object.fromEntries(Object.entries(lock.packages || {}).filter(([key, value]) => key &&
    (value.name || key.split('node_modules/').at(-1)) === 'picomatch').map(([key, value]) => {
    requireThat(value.dev === true, 'picomatch must remain development-only');
    return [key, value.version];
  }));
  requireThat(stable(found) === stable(EXPECTED), 'New dependency path or changed picomatch version');
}
function git(root, args) {
  return execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], { cwd: root, windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}
function sourceState(root) {
  requireThat(git(root, ['status', '--porcelain=v1', '--untracked-files=all']).trim() === '', 'A clean, fully committed checkout is required');
  const commit = git(root, ['rev-parse', 'HEAD']).trim();
  requireThat(/^[a-f0-9]{40}$/.test(commit), 'Invalid fixed commit');
  const files = git(root, ['ls-files', '-z']).split('\0').filter(Boolean).sort().map(file => {
    safeRelative(file);
    const stat = fs.lstatSync(path.join(root, file));
    requireThat(stat.isFile() && !stat.isSymbolicLink(), 'Source links and special files are not accepted');
    return { file, sha256: sha(fs.readFileSync(path.join(root, file))) };
  });
  // git status omits ignored files. Vite can load an ignored .env file and
  // Tailwind can scan ignored src/dist/*.jsx, so check the actual filesystem.
  const tracked = new Set(files.map(value => value.file));
  const generated = new Set(['.git', 'node_modules', 'dist', 'release', 'test-results', 'playwright-report', 'coverage', 'out', 'output', '.cache', '.startup-qa', '.risk-build', 'tmp']);
  function walk(relative = '') {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      if (!relative && generated.has(entry.name)) continue;
      const file = relative ? `${relative}/${entry.name}` : entry.name;
      requireThat(!entry.isSymbolicLink(), 'Unreviewed filesystem link');
      if (entry.isDirectory()) walk(file);
      else requireThat(tracked.has(file), `Unreviewed ignored or external source file: ${file}`);
    }
  }
  walk();
  return { commit, sourceSha256: sha(stable(files)) };
}
function evidenceState(root) {
  return EVIDENCE.map(file => ({ file, sha256: sha(fs.readFileSync(path.join(root, safeRelative(file)))) }));
}
function installationState(root) {
  const base = path.join(root, 'node_modules'), files = [];
  function walk(relative = '') {
    for (const entry of fs.readdirSync(path.join(base, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const name = relative ? `${relative}/${entry.name}` : entry.name, file = path.join(base, name);
      if (entry.isSymbolicLink()) {
        const target = fs.realpathSync(file);
        requireThat(target.startsWith(base + path.sep), 'Installed dependency link escapes node_modules');
        files.push({ file: name, link: fs.readlinkSync(file) });
      } else if (entry.isDirectory()) walk(name);
      else { requireThat(entry.isFile(), 'Special installed dependency file'); files.push({ file: name, sha256: sha(fs.readFileSync(file)) }); }
    }
  }
  walk(); return sha(stable(files));
}
const REVIEW_FILES = ['commands.jsonl', 'audit-status.json', ...['install', 'dependency-policy', 'audit-full', 'audit-production', 'picomatch-probes'].flatMap(name => [`${name}.stdout`, `${name}.stderr`])];
function sealReview(root, directory, context) {
  const state = { schemaVersion: 1, completedAt: new Date().toISOString(), context,
    source: sourceState(root), lockSha256: sha(fs.readFileSync(path.join(root, 'package-lock.json'))), installationSha256: installationState(root),
    files: REVIEW_FILES.map(file => ({ file, sha256: sha(fs.readFileSync(path.join(directory, file))) })) };
  fs.writeFileSync(path.join(directory, 'review-state.json'), JSON.stringify(state, null, 2) + '\n', { flag: 'wx' });
  return verifyReview(root, directory, context);
}
function verifyReview(root, directory, context, now = Date.now()) {
  requireThat(directory.startsWith(path.join(root, '.risk-build') + path.sep), 'Review must belong to this checkout');
  const bytes = fs.readFileSync(path.join(directory, 'review-state.json')), state = JSON.parse(bytes);
  const age = now - timestamp(state.completedAt);
  requireThat(state.schemaVersion === 1 && age >= 0 && age < 3600000, 'Prepared review is stale or invalid');
  requireThat(state.context.kind === context.kind && state.context.repository === context.repository && state.context.runId === context.runId && state.context.attempt === '1' && context.attempt === '1', 'Prepared review belongs to another run');
  requireThat(stable(state.source) === stable(sourceState(root)) && state.lockSha256 === sha(fs.readFileSync(path.join(root, 'package-lock.json'))), 'Prepared source or lockfile changed');
  requireThat(state.installationSha256 === installationState(root), 'Prepared installed dependencies changed');
  requireThat(stable(state.files.map(value => value.file)) === stable(REVIEW_FILES), 'Prepared evidence set changed');
  for (const entry of state.files) requireThat(sha(fs.readFileSync(path.join(directory, safeRelative(entry.file)))) === entry.sha256, 'Prepared raw evidence changed');
  const status = JSON.parse(fs.readFileSync(path.join(directory, 'audit-status.json')));
  if (status.currentRiskReviewSha256) requireThat(sha(fs.readFileSync(path.join(directory, 'current-risk-review.json'))) === status.currentRiskReviewSha256, 'Current performance-risk evidence changed');
  if (status.boundaryTestsSha256) requireThat(sha(fs.readFileSync(path.join(directory, 'build-boundary-tests.stdout'))) === status.boundaryTestsSha256, 'Build boundary evidence changed');
  return { directory: path.relative(root, directory).replaceAll('\\', '/'), sha256: sha(bytes) };
}
function checkInputs(root) {
  const policy = JSON.parse(fs.readFileSync(path.join(root, 'security-audit/picomatch-build-inputs.json')));
  requireThat(policy.schemaVersion === 1 && policy.externalGlobInputs === false, 'Unreviewed glob inputs');
  requireThat(stable(Object.keys(policy.files).sort()) === stable(['tailwind.config.js', 'vite.config.js', 'postcss.config.js', 'build/build-windows.cjs', 'build/portable-fast.nsi'].sort()), 'Incomplete build input review');
  for (const [file, hash] of Object.entries(policy.files)) requireThat(sha(fs.readFileSync(path.join(root, safeRelative(file)))) === hash, `Build input review changed: ${file}`);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  requireThat(pkg.scripts.build === 'vite build' && pkg.scripts['dist:all'] === 'npm run build && node build/build-windows.cjs nsis portable zip', 'Unreviewed build command');
  requireThat(stable(pkg.build.files) === stable(['dist/**/*', 'electron/**/*', 'src/model.mjs', 'src/mutations.mjs', 'package.json', '!node_modules/exceljs-hardened/dist/**']), 'Unreviewed package input patterns');
  requireThat(!fs.existsSync(path.join(root, '.npmrc')), 'Repository npm configuration requires review');
  return policy;
}
function checkContext(statement, context) {
  requireThat(context && stable(statement.context) === stable(context), 'Authorization is bound to a different run/context');
  requireThat(context.attempt === '1', 'Authorization cannot be used for a rerun');
  requireThat(context.repository === 'limo-577/N7M---Custom-Email-Management', 'Untrusted repository');
  if (context.kind === 'github') {
    requireThat(context.event === 'workflow_dispatch' && context.ref === 'refs/heads/main' && /^\d+$/.test(context.runId), 'Untrusted workflow event/ref');
    requireThat(context.workflowRef === `${context.repository}/.github/workflows/controlled-build.yml@refs/heads/main`, 'Untrusted workflow');
  } else requireThat(context.kind === 'local-verification' && /^[a-f0-9-]{36}$/.test(context.runId) &&
    typeof context.ledgerDirectory === 'string' && path.isAbsolute(context.ledgerDirectory), 'Invalid local verification context or durable ledger');
}
function verifyEnvelope(envelope, publicKey) {
  requireThat(envelope && Object.keys(envelope).sort().join(',') === 'signature,statement', 'Invalid signed envelope');
  const key = crypto.createPublicKey(publicKey);
  requireThat(key.asymmetricKeyType === 'ed25519', 'Only Ed25519 approval keys are accepted');
  requireThat(typeof envelope.signature === 'string' && /^[A-Za-z0-9+/]{86}==$/.test(envelope.signature), 'Invalid authorization signature');
  requireThat(crypto.verify(null, Buffer.from(stable(envelope.statement)), key, Buffer.from(envelope.signature, 'base64')), 'Authorization signature verification failed');
  return envelope.statement;
}
function authenticate({ root, envelope, publicKey, context, now = Date.now(), revoked = false }) {
  const statement = verifyEnvelope(envelope, publicKey);
  requireThat(statement.schemaVersion === 1 && statement.advisory === ADVISORY && statement.acknowledgement === ACK &&
    /^[a-f0-9-]{36}$/.test(statement.id) && typeof statement.approvedBy === 'string' && statement.approvedBy.length > 0 &&
    typeof statement.reason === 'string' && statement.reason.length >= 20, 'Invalid acceptance statement');
  requireThat(!revoked, 'Authorization has been revoked');
  checkWindow(statement, now); checkContext(statement, context);
  const reviewedAudit = JSON.parse(fs.readFileSync(path.join(root, 'security-audit/2026-11-18/audit-full.result.json')));
  requireThat(reviewedAudit.code === 1 && !reviewedAudit.error && !reviewedAudit.signal && statement.evidenceAt === reviewedAudit.end, 'Audit investigation timestamp/evidence is invalid');
  const source = sourceState(root);
  requireThat(source.commit === statement.commit && source.sourceSha256 === statement.sourceSha256, 'Fixed commit or reviewed source changed');
  const bytes = fs.readFileSync(path.join(root, 'package-lock.json'));
  requireThat(sha(bytes) === statement.lockSha256, 'Lockfile SHA-256 changed');
  const lock = JSON.parse(bytes); checkLock(lock); checkInputs(root);
  requireThat(stable(statement.dependencies) === stable(EXPECTED), 'Acceptance dependency pins changed');
  requireThat(stable(statement.evidence) === stable(evidenceState(root)), 'Reviewed evidence missing or invalid');
  return { statement, source, lock };
}
function evaluate(input) {
  const { statement, source, lock } = authenticate(input);
  const inspected = inspectAudit(input.rawAudit, lock);
  requireThat(inspected.rawSha256 === statement.auditSha256, 'Current raw audit evidence changed');
  return { mode: 'picomatch-once', acceptedRisk: true, vulnerabilityFixed: false, authorizationId: statement.id, commit: source.commit, expiresAt: statement.expiresAt, ...inspected };
}
function consume(stateDirectory, statement) {
  requireThat(path.isAbsolute(stateDirectory), 'Durable ledger path must be absolute');
  requireThat(/^[a-f0-9-]{36}$/.test(statement.id), 'Invalid authorization ID');
  if (statement.context.kind === 'local-verification') requireThat(path.resolve(stateDirectory) === statement.context.ledgerDirectory, 'Authorization is bound to a different durable ledger');
  fs.mkdirSync(stateDirectory, { recursive: true });
  requireThat(!fs.existsSync(path.join(stateDirectory, `${statement.id}.revoked.json`)), 'Authorization has been revoked');
  const receipt = { authorizationId: statement.id, statementSha256: sha(stable(statement)), consumedAt: new Date().toISOString(), context: statement.context, state: 'consumed-before-build' };
  const file = path.join(stateDirectory, `${statement.id}.consumed.json`);
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(receipt, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return receipt;
}
function revoke(stateDirectory, id, reason) {
  requireThat(path.isAbsolute(stateDirectory) && /^[a-f0-9-]{36}$/.test(id) && typeof reason === 'string' && reason.length >= 10, 'Invalid revocation');
  fs.mkdirSync(stateDirectory, { recursive: true });
  fs.writeFileSync(path.join(stateDirectory, `${id}.revoked.json`), JSON.stringify({ id, reason, revokedAt: new Date().toISOString() }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
function issue({ root, rawAudit, context, privateKey, approvedBy, reason, issuedAt, expiresAt, evidenceAt, acknowledgement, review }) {
  requireThat(acknowledgement === ACK, 'Explicit risk acknowledgement is required');
  const lockBytes = fs.readFileSync(path.join(root, 'package-lock.json')); const lock = JSON.parse(lockBytes);
  checkLock(lock); checkInputs(root); inspectAudit(rawAudit, lock);
  const statement = { schemaVersion: 1, id: crypto.randomUUID(), advisory: ADVISORY, acknowledgement, approvedBy, reason,
    ...sourceState(root), lockSha256: sha(lockBytes), auditSha256: sha(rawAudit), dependencies: EXPECTED,
    evidence: evidenceState(root), issuedAt, expiresAt, evidenceAt, context, ...(review ? { review } : {}) };
  requireThat(!review || context.kind === 'local-verification', 'Prepared continuation is local-only; GitHub must run its fresh gates');
  checkWindow(statement, timestamp(issuedAt)); checkContext(statement, context);
  const key = crypto.createPrivateKey(privateKey); requireThat(key.asymmetricKeyType === 'ed25519', 'Approval key must be Ed25519');
  const envelope = { statement, signature: crypto.sign(null, Buffer.from(stable(statement)), key).toString('base64') };
  // Issuance is subject to exactly the same checks as execution.
  evaluate({ root, rawAudit, envelope, publicKey: crypto.createPublicKey(key).export({ type: 'spki', format: 'pem' }), context, now: timestamp(issuedAt) });
  return envelope;
}
module.exports = { ADVISORY, ACK, EXPECTED, EVIDENCE, REVIEW_FILES, sha, stable, requireThat, safeRelative, checkWindow, inspectAudit, checkLock, sourceState, evidenceState, installationState, sealReview, verifyReview, checkInputs, checkContext, verifyEnvelope, authenticate, evaluate, consume, revoke, issue };
