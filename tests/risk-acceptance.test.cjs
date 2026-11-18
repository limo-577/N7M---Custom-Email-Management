'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const risk = require('../build/risk-acceptance.cjs');
const { options, cleanEnvironment, main } = require('../build/controlled-build.cjs');
const root = path.resolve(__dirname, '..');
const keys = crypto.generateKeyPairSync('ed25519');
const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' });
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
const issuedAt = '2026-11-18T10:00:00.000Z';
const expiresAt = '2026-11-25T10:00:00.000Z';
const context = { kind: 'local-verification', repository: 'limo-577/N7M---Custom-Email-Management', runId: crypto.randomUUID(), attempt: '1' };
let directory, rawAudit, envelope;
function commit() {
  const git = args => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.hooksPath=NUL', ...args], { cwd: directory, windowsHide: true, stdio: 'pipe' });
  git(['init', '--quiet']); git(['add', '.']);
  git(['-c', 'user.name=N7M test', '-c', 'user.email=tests@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Reviewed test fixture']);
}
test.before(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'n7m-risk-tests-'));
  context.ledgerDirectory = path.join(directory, '.risk-build/ledger');
  const files = ['.gitignore', 'package.json', 'package-lock.json', ...risk.EVIDENCE,
    'tailwind.config.js', 'vite.config.js', 'postcss.config.js', 'build/build-windows.cjs', 'build/portable-fast.nsi'];
  for (const file of files) { fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true }); fs.copyFileSync(path.join(root, file), path.join(directory, file)); }
  commit(); rawAudit = fs.readFileSync(path.join(root, 'security-audit/2026-11-18/npm-audit-full.raw.json'));
  envelope = risk.issue({ root: directory, rawAudit, context, privateKey, approvedBy: 'test authority', reason: 'Test-only one-run acceptance; no publication permitted.', issuedAt, expiresAt, evidenceAt: '2026-11-18T08:02:05.945Z', acknowledgement: risk.ACK });
});
test.after(() => {
  const absolute = path.resolve(directory);
  assert.ok(absolute.startsWith(path.join(path.resolve(os.tmpdir()), 'n7m-risk-tests-')));
  fs.rmSync(absolute, { recursive: true, force: true });
});
function input(extra = {}) { return { root: directory, rawAudit, context: structuredClone(context), envelope: structuredClone(envelope), publicKey, now: Date.parse(issuedAt), ...extra }; }
function resign(statement) { return { statement, signature: crypto.sign(null, Buffer.from(risk.stable(statement)), keys.privateKey).toString('base64') }; }
function altered(change) { const statement = structuredClone(envelope.statement); change(statement); return input({ envelope: resign(statement) }); }

test('strict is the default and missing/unknown/duplicate modes cannot enable an exception', () => {
  assert.equal(options([]).mode, 'strict');
  for (const args of [['--mode', 'disable-audit'], ['--mode'], ['--mode', 'strict', '--mode', 'picomatch-once'], ['--glob', '+(*a)'], ['--skip-audit', 'true']]) assert.throws(() => options(args));
});
test('signed one-run acceptance reports all 18 high findings without claiming a fix', () => {
  const result = risk.evaluate(input()); assert.equal(result.count, 18); assert.equal(result.vulnerable, true); assert.equal(result.vulnerabilityFixed, false); assert.equal(result.acceptedRisk, true);
});
test('expiry boundary, future activation and durations over seven days fail closed', () => {
  assert.throws(() => risk.evaluate(input({ now: Date.parse(expiresAt) })), /expired/);
  assert.throws(() => risk.evaluate(input({ now: Date.parse(issuedAt) - 1 })), /not active/);
  assert.throws(() => risk.evaluate(altered(s => { s.expiresAt = '2026-11-25T10:00:00.001Z'; })), /seven days/);
});
test('invalid dates and stale review evidence fail closed', () => {
  assert.throws(() => risk.evaluate(altered(s => { s.issuedAt = '2026-99-18'; })), /timestamp/);
  assert.throws(() => risk.evaluate(altered(s => { s.evidenceAt = '2026-11-10T00:00:00.000Z'; })), /stale/);
});
test('unknown high and low advisories cannot be hidden inside the existing affected chain', () => {
  for (const severity of ['high', 'low']) {
    const report = JSON.parse(rawAudit);
    report.vulnerabilities.picomatch.via.push({ name: 'picomatch', url: 'https://github.com/advisories/GHSA-xxxx-yyyy-zzzz', severity, range: '*' });
    assert.throws(() => risk.inspectAudit(JSON.stringify(report), require('../package-lock.json')), /Unknown advisory/);
  }
});
test('new dependencies, changed versions and production applicability are refused', () => {
  const lock = structuredClone(require('../package-lock.json'));
  lock.packages['node_modules/new-parent/node_modules/picomatch'] = { version: '4.0.7', dev: true };
  assert.throws(() => risk.checkLock(lock), /New dependency path/);
  delete lock.packages['node_modules/new-parent/node_modules/picomatch'];
  lock.packages['node_modules/picomatch'].version = '4.0.8';
  assert.throws(() => risk.checkLock(lock), /changed picomatch version/);
  lock.packages['node_modules/picomatch'].version = '2.3.2'; lock.packages['node_modules/picomatch'].dev = false;
  assert.throws(() => risk.checkLock(lock), /development-only/);
});
test('new audit paths, rootless cycles, malformed reports and false zero totals are refused', () => {
  const report = JSON.parse(rawAudit), lock = structuredClone(require('../package-lock.json'));
  const added = 'node_modules/new/node_modules/picomatch'; lock.packages[added] = { version: '4.0.7', dev: true };
  report.vulnerabilities.picomatch.nodes.push(added);
  assert.throws(() => risk.inspectAudit(JSON.stringify(report), lock), /picomatch audit path/);
  const bad = JSON.parse(rawAudit); bad.vulnerabilities.anymatch.via = ['anymatch'];
  assert.throws(() => risk.inspectAudit(JSON.stringify(bad), lock), /rootless/);
  assert.throws(() => risk.inspectAudit('{"error":{"code":"ENETDOWN"}}', lock), /Invalid npm/);
  bad.metadata.vulnerabilities.total = 0;
  assert.throws(() => risk.inspectAudit(JSON.stringify(bad), lock));
});
test('lockfile SHA, fixed commit and exact raw audit bytes are pinned', () => {
  assert.throws(() => risk.evaluate(altered(s => { s.lockSha256 = '0'.repeat(64); })), /Lockfile SHA/);
  assert.throws(() => risk.evaluate(altered(s => { s.commit = '0'.repeat(40); })), /Fixed commit/);
  assert.throws(() => risk.evaluate(input({ rawAudit: Buffer.concat([rawAudit, Buffer.from('\n')]) })), /raw audit evidence changed/);
});
test('signature forgery, missing evidence and mismatched evidence hashes are refused', () => {
  const changed = input(); changed.envelope.statement.expiresAt = '2026-11-26T10:00:00.000Z';
  assert.throws(() => risk.evaluate(changed), /signature verification/);
  assert.throws(() => risk.evaluate(altered(s => { s.evidence.pop(); })), /evidence missing or invalid/);
  assert.throws(() => risk.evaluate(altered(s => { s.evidence[0].sha256 = '0'.repeat(64); })), /evidence missing or invalid/);
});
test('uncommitted/unreviewed external input invalidates the trusted source checkout', () => {
  const file = path.join(directory, 'external-globs.json'); fs.writeFileSync(file, '["+(*a)"]');
  try { assert.throws(() => risk.evaluate(input()), /clean, fully committed/); }
  finally { fs.unlinkSync(file); }
  const config = path.join(directory, 'tailwind.config.js'), original = fs.readFileSync(config);
  try { fs.writeFileSync(config, "export default {content: process.env.EXTERNAL_GLOB};"); assert.throws(() => risk.checkInputs(directory), /Build input review changed/); }
  finally { fs.writeFileSync(config, original); }
  const ignored = path.join(directory, 'src/dist/injected.jsx');
  fs.mkdirSync(path.dirname(ignored), { recursive: true }); fs.writeFileSync(ignored, 'export default "unreviewed";');
  try { assert.throws(() => risk.sourceState(directory), /Unreviewed ignored or external source file/); }
  finally { fs.unlinkSync(ignored); }
  const dotenv = path.join(directory, '.env.production'); fs.writeFileSync(dotenv, 'VITE_EXTERNAL_GLOB=+(*a)');
  try { assert.throws(() => risk.sourceState(directory), /Unreviewed ignored or external source file/); }
  finally { fs.unlinkSync(dotenv); }
});
test('path traversal, shell metacharacters and environment glob/Node injection are refused or stripped', () => {
  assert.equal(risk.safeRelative('N7M-新手图册.pdf'), 'N7M-新手图册.pdf');
  for (const value of ['../package.json', 'C:/x', '/x', 'a//b', 'a/../../b', 'x;touch-file', '$(whoami)', 'a\\b']) assert.throws(() => risk.safeRelative(value));
  const env = cleanEnvironment({ PATH: 'tools', SystemRoot: 'Windows', NODE_OPTIONS: '--require evil.cjs', NODE_PATH: 'evil', NPM_CONFIG_REGISTRY: 'evil', EXTERNAL_GLOB: '+(*a)', GITHUB_TOKEN: 'secret', ELECTRON_MIRROR: 'evil' });
  assert.deepEqual(Object.keys(env).sort(), ['CI', 'CSC_IDENTITY_AUTO_DISCOVERY', 'PATH', 'SystemRoot'].sort());
});
test('wrong repository, different run and reruns cannot reuse an authorization', () => {
  assert.throws(() => risk.evaluate(input({ context: { ...context, runId: crypto.randomUUID() } })), /different run/);
  assert.throws(() => risk.evaluate(altered(s => { s.context.attempt = '2'; })), /different run/);
  assert.throws(() => risk.checkContext({ context: { ...context, attempt: '2' } }, { ...context, attempt: '2' }), /rerun/);
  assert.throws(() => risk.checkContext({ context: { ...context, repository: 'attacker/fork' } }, { ...context, repository: 'attacker/fork' }), /Untrusted repository/);
});
test('acceptance is atomically consumed once and revocation also blocks unspent authorizations', () => {
  const ledger = context.ledgerDirectory;
  const receipt = risk.consume(ledger, envelope.statement);
  assert.equal(receipt.authorizationId, envelope.statement.id);
  assert.throws(() => risk.consume(ledger, envelope.statement), /EEXIST/);
  assert.throws(() => risk.consume(path.join(directory, '.risk-build/another-ledger'), envelope.statement), /different durable ledger/);
  const other = { ...envelope.statement, id: crypto.randomUUID() };
  risk.revoke(ledger, other.id, 'Explicit test revocation');
  assert.throws(() => risk.consume(ledger, other), /revoked/);
  assert.throws(() => risk.evaluate(input({ revoked: true })), /revoked/);
});
test('issuance requires explicit risk acknowledgement and revocation requires an explicit ledger', async () => {
  assert.throws(() => risk.issue({ acknowledgement: 'continue' }), /Explicit risk acknowledgement/);
  await assert.rejects(main(['--mode', 'revoke', '--id', crypto.randomUUID(), '--reason', 'No ledger must be refused']), /explicit durable ledger/);
});

test('simultaneous consumers cannot both acquire the same one-run authorization', async () => {
  const statement = { ...envelope.statement, id: crypto.randomUUID() };
  const script = `const risk=require(process.argv[1]);try {risk.consume(process.argv[2],JSON.parse(process.argv[3]));process.exitCode=0;} catch {process.exitCode=23;}`;
  const run = () => new Promise((resolve, reject) => {
    const child = require('node:child_process').spawn(process.execPath, ['-e', script, require.resolve('../build/risk-acceptance.cjs'), context.ledgerDirectory, JSON.stringify(statement)], { windowsHide: true, stdio: 'ignore' });
    child.on('error', reject); child.on('close', resolve);
  });
  assert.deepEqual((await Promise.all([run(), run()])).sort((a, b) => a - b), [0, 23]);
});

test('same-run continuation refuses altered installation, raw evidence and stale preparation', () => {
  const prepared = path.join(directory, '.risk-build/prepared-test'); fs.mkdirSync(prepared, { recursive: true });
  const moduleFile = path.join(directory, 'node_modules/seal-fixture/index.js'); fs.mkdirSync(path.dirname(moduleFile), { recursive: true }); fs.writeFileSync(moduleFile, '// reviewed installation');
  for (const file of risk.REVIEW_FILES) fs.writeFileSync(path.join(prepared, file), file === 'audit-status.json' ? '{}' : 'fixture evidence');
  risk.sealReview(directory, prepared, context);
  const original = risk.verifyReview(directory, prepared, context);
  fs.appendFileSync(moduleFile, '\n// unreviewed change');
  assert.throws(() => risk.verifyReview(directory, prepared, context), /installed dependencies changed/);
  fs.writeFileSync(moduleFile, '// reviewed installation');
  const raw = path.join(prepared, 'audit-full.stdout'); fs.appendFileSync(raw, '\n');
  assert.throws(() => risk.verifyReview(directory, prepared, context), /raw evidence changed/);
  fs.writeFileSync(raw, 'fixture evidence');
  assert.deepEqual(risk.verifyReview(directory, prepared, context), original);
  const statusFile = path.join(prepared, 'audit-status.json');
  const decisionFile = path.join(prepared, 'current-risk-review.json');
  fs.writeFileSync(decisionFile, JSON.stringify({ releaseEligible: false }));
  fs.writeFileSync(statusFile, JSON.stringify({ currentRiskReviewSha256: risk.sha(fs.readFileSync(decisionFile)) }));
  // Seal this variant separately, preserving the original review evidence.
  const variant = path.join(directory, '.risk-build/prepared-current-test'); fs.mkdirSync(variant);
  for (const file of [...risk.REVIEW_FILES, 'current-risk-review.json']) fs.copyFileSync(path.join(prepared, file), path.join(variant, file));
  risk.sealReview(directory, variant, context);
  fs.writeFileSync(path.join(variant, 'current-risk-review.json'), JSON.stringify({ releaseEligible: true }));
  assert.throws(() => risk.verifyReview(directory, variant, context), /performance-risk evidence changed/);
  fs.writeFileSync(statusFile, '{}');
  const state = JSON.parse(fs.readFileSync(path.join(prepared, 'review-state.json')));
  assert.throws(() => risk.verifyReview(directory, prepared, context, Date.parse(state.completedAt) + 3600000), /stale/);
});
