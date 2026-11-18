'use strict';
// This controller never changes npm's audit report or its recorded exit code.
// Its separate decision is either strict refusal or a signed, one-run exception.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const risk = require('./risk-acceptance.cjs');
const currentRisk = require('./current-risk-review.cjs');
const { boundedStep } = require('./bounded-step.cjs');
const ROOT = path.resolve(__dirname, '..');
function options(args) {
  const result = { mode: 'strict' };
  const allowed = new Set(['mode', 'output', 'envelope', 'public-key', 'ledger', 'run-id', 'private-key', 'approved-by', 'reason', 'expires-at', 'evidence-at', 'acknowledgement', 'id', 'context', 'prepared']);
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]?.slice(2), value = args[index + 1];
    risk.requireThat(args[index]?.startsWith('--') && allowed.has(name) && value && !value.startsWith('--') && !Object.hasOwn(result, name === 'mode' ? '_mode' : name), 'Unknown, duplicate or malformed argument');
    if (name === 'mode') result._mode = true;
    result[name] = value;
  }
  risk.requireThat(['strict', 'review', 'picomatch-once', 'issue', 'revoke'].includes(result.mode), 'Invalid build mode');
  return result;
}
function cleanEnvironment(source = process.env) {
  // Deliberately exclude NODE_OPTIONS/NODE_PATH, npm overrides, Electron mirror
  // overrides, arbitrary glob variables, signing keys and GitHub credentials.
  const names = new Set(['path', 'pathext', 'systemroot', 'windir', 'systemdrive', 'comspec', 'temp', 'tmp', 'userprofile', 'appdata', 'localappdata', 'programfiles', 'programfiles(x86)', 'programdata', 'homedrive', 'homepath', 'home', 'number_of_processors', 'processor_architecture', 'https_proxy', 'http_proxy', 'no_proxy']);
  const result = Object.fromEntries(Object.entries(source).filter(([key]) => names.has(key.toLowerCase())));
  return { ...result, CI: 'true', CSC_IDENTITY_AUTO_DISCOVERY: 'false' };
}
function contextFromEnvironment(runId, ledger) {
  if (process.env.GITHUB_ACTIONS === 'true') return {
    kind: 'github', repository: process.env.GITHUB_REPOSITORY, runId: process.env.GITHUB_RUN_ID,
    attempt: process.env.GITHUB_RUN_ATTEMPT, event: process.env.GITHUB_EVENT_NAME,
    ref: process.env.GITHUB_REF, workflowRef: process.env.GITHUB_WORKFLOW_REF
  };
  risk.requireThat(/^[a-f0-9-]{36}$/.test(runId || ''), 'A fixed local verification run ID is required');
  return { kind: 'local-verification', repository: 'limo-577/N7M---Custom-Email-Management', runId, attempt: '1', ...(ledger ? { ledgerDirectory: path.resolve(ledger) } : {}) };
}
function append(file, value) { fs.appendFileSync(file, JSON.stringify(value) + '\n'); }
function runStep({ name, executable, args, output, env, timeout = 600000 }) {
  const startedAt = new Date().toISOString();
  const child = boundedStep({ name, executable, args, output, env, cwd: ROOT, timeout });
  const result = { name, command: [executable, ...args], startedAt, finishedAt: new Date().toISOString(), code: child.status, signal: child.signal, error: child.error?.code || null, containment: child.containment };
  append(path.join(output, 'commands.jsonl'), result);
  console.log(`${name}: exit ${child.status}${child.error ? ` (${child.error.code})` : ''}`);
  return result;
}
async function main(args = process.argv.slice(2)) {
  const opts = options(args);
  if (opts.mode === 'revoke') {
    risk.requireThat(opts.ledger && path.isAbsolute(opts.ledger) && !path.resolve(opts.ledger).startsWith(ROOT + path.sep), 'Revocation requires an explicit durable ledger outside the checkout');
    risk.revoke(path.resolve(opts.ledger), opts.id, opts.reason); return;
  }
  risk.requireThat(!opts.context || opts.mode === 'issue', 'External context is only allowed when issuing a signed approval');
  const context = opts.mode === 'issue' && opts.context ? JSON.parse(fs.readFileSync(opts.context)) : contextFromEnvironment(opts['run-id'] || (['strict', 'review'].includes(opts.mode) ? crypto.randomUUID() : undefined), opts.ledger);
  const output = path.resolve(opts.output || path.join(ROOT, '.risk-build', context.runId, opts.mode));
  risk.requireThat(output.startsWith(path.join(ROOT, '.risk-build') + path.sep), 'Reports must be in this checkout .risk-build directory');
  fs.mkdirSync(output, { recursive: true });
  risk.requireThat(!fs.readdirSync(output).length, 'An empty output directory is required; evidence cannot be overwritten');
  const source = risk.sourceState(ROOT); risk.checkInputs(ROOT);
  if (opts.ledger) risk.requireThat(!path.resolve(opts.ledger).startsWith(ROOT + path.sep), 'The durable approval ledger must be outside the checkout');
  let envelope, approval, ledger, publicKey, receipt;
  if (opts.mode === 'picomatch-once') {
    risk.requireThat(opts.envelope && opts['public-key'] && opts.ledger, 'Explicit signed approval, public key and durable ledger are required');
    envelope = JSON.parse(fs.readFileSync(opts.envelope)); publicKey = fs.readFileSync(opts['public-key']); ledger = path.resolve(opts.ledger);
    risk.authenticate({ root: ROOT, envelope, publicKey, context,
      revoked: fs.existsSync(path.join(ledger, `${envelope.statement.id}.revoked.json`)) });
    risk.requireThat(!fs.existsSync(path.join(ledger, `${envelope.statement.id}.consumed.json`)), 'Authorization was already consumed');
    if (context.kind === 'github') risk.requireThat(process.env.N7M_RISK_REVOKED === 'false', 'GitHub authorization missing or revoked');
  }
  const env = cleanEnvironment();
  // Isolate user/global npm configuration as well as environment overrides.
  const npmrc = path.join(output, 'empty.npmrc'); fs.writeFileSync(npmrc, '');
  env.NPM_CONFIG_USERCONFIG = npmrc; env.NPM_CONFIG_GLOBALCONFIG = path.join(output, 'empty-global.npmrc');
  fs.writeFileSync(env.NPM_CONFIG_GLOBALCONFIG, '');
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  const step = (name, args, timeout) => runStep({ name, executable: process.execPath, args, output, env, timeout });
  const npm = (name, args, timeout) => step(name, [npmCli, ...args], timeout);
  const must = result => risk.requireThat(result.code === 0 && !result.error && !result.signal, `Required command failed: ${result.name}`);
  risk.requireThat(process.version === 'v24.13.0', 'Node must be the verified 24.13.0');
  const npmVersion = spawnSync(process.execPath, [npmCli, '--version'], { env, encoding: 'utf8', windowsHide: true });
  risk.requireThat(npmVersion.status === 0 && npmVersion.stdout.trim() === '11.6.2', 'npm must be the verified 11.6.2');
  if (opts.mode === 'issue') {
    risk.requireThat(opts.envelope && opts['private-key'], 'Issue requires an external approval key and envelope output');
    // This branch consumes existing, fresh review output, not invented stdout.
    const audit = fs.readFileSync(path.resolve(opts.envelope, '../audit-full.stdout'));
    const commands = fs.readFileSync(path.resolve(opts.envelope, '../commands.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const record = commands.find(value => value.name === 'audit-full');
    const age = record ? Date.now() - Date.parse(record.finishedAt) : NaN;
    risk.requireThat(record?.code === 1 && !record.error && !record.signal && age >= 0 && age < 3600000, 'A fresh real audit review is required');
    const envelope = risk.issue({ root: ROOT, rawAudit: audit, context, privateKey: fs.readFileSync(opts['private-key']),
      approvedBy: opts['approved-by'], reason: opts.reason, issuedAt: new Date().toISOString(), expiresAt: opts['expires-at'], evidenceAt: opts['evidence-at'], acknowledgement: opts.acknowledgement,
      review: context.kind === 'local-verification' ? risk.verifyReview(ROOT, path.dirname(path.resolve(opts.envelope)), context) : undefined });
    fs.writeFileSync(opts.envelope, JSON.stringify(envelope, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(`Issued one-run authorization ${envelope.statement.id}; no vulnerability is fixed.`); return;
  }
  let full, production, probes;
  if (opts.prepared) {
    risk.requireThat(opts.mode === 'picomatch-once' && context.kind === 'local-verification', 'Prepared continuation is only available for a signed local run');
    const prepared = path.resolve(opts.prepared);
    const verified = risk.verifyReview(ROOT, prepared, context);
    risk.requireThat(risk.stable(verified) === risk.stable(envelope.statement.review), 'Prepared review is not the signed evidence');
    for (const file of risk.REVIEW_FILES.filter(name => name !== 'commands.jsonl' && name !== 'audit-status.json')) fs.copyFileSync(path.join(prepared, file), path.join(output, file), fs.constants.COPYFILE_EXCL);
    const commands = fs.readFileSync(path.join(prepared, 'commands.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    full = commands.find(value => value.name === 'audit-full'); production = commands.find(value => value.name === 'audit-production'); probes = commands.find(value => value.name === 'picomatch-probes');
    must(commands.find(value => value.name === 'install')); must(commands.find(value => value.name === 'dependency-policy'));
    append(path.join(output, 'commands.jsonl'), { name: 'continue-same-reviewed-run', evidenceDirectory: verified.directory, reviewSha256: verified.sha256, resumedAt: new Date().toISOString(), note: 'No audit rerun or fabricated exit code. Exact preceding audit, installation and probes are bound by the signature.' });
    fs.copyFileSync(path.join(prepared, 'commands.jsonl'), path.join(output, 'preceding-review-commands.jsonl'));
    console.log('Continuing the same installed and audited local run; every raw evidence byte and installed file was revalidated.');
  } else {
    must(npm('install', ['ci']));
    risk.requireThat(risk.stable(source) === risk.stable(risk.sourceState(ROOT)), 'Installation modified reviewed source');
    must(npm('dependency-policy', ['run', 'check:dependencies']));
    full = npm('audit-full', ['audit', '--audit-level=low', '--json']);
    production = npm('audit-production', ['audit', '--omit=dev', '--audit-level=low', '--json']);
    probes = npm('picomatch-probes', ['run', '--silent', 'check:picomatch'], 90000);
  }
  const rawAudit = fs.readFileSync(path.join(output, 'audit-full.stdout'));
  const rawProduction = JSON.parse(fs.readFileSync(path.join(output, 'audit-production.stdout')));
  must(production);
  risk.requireThat(rawProduction.metadata?.vulnerabilities?.total === 0 && !rawProduction.error, 'Production vulnerabilities cannot be accepted');
  const reports = { fullAuditExit: full.code, productionAuditExit: production.code, isolatedProbeExit: probes.code,
    rawAuditSha256: risk.sha(rawAudit), vulnerabilityFixed: false, source, mode: opts.mode };
  fs.writeFileSync(path.join(output, 'audit-status.json'), JSON.stringify(reports, null, 2) + '\n');
  let currentDecision;
  if (full.code === 0 && ['strict', 'review'].includes(opts.mode)) {
    const protection = step('build-boundary-tests', ['--test', '--test-reporter=tap', 'tests/glob-build-guard.test.cjs', 'tests/bounded-step.test.cjs']);
    must(protection);
    currentDecision = currentRisk.review({ root: ROOT, rawAudit,
      rawProduction: fs.readFileSync(path.join(output, 'audit-production.stdout')),
      rawProbes: fs.readFileSync(path.join(output, 'picomatch-probes.stdout')), full, production, probes,
      protection, protectionOutput: fs.readFileSync(path.join(output, 'build-boundary-tests.stdout')) });
    fs.writeFileSync(path.join(output, 'current-risk-review.json'), JSON.stringify(currentDecision, null, 2) + '\n', { flag: 'wx' });
    // Bind this additional decision to the exact bytes of the existing sealed review.
    reports.currentRiskReviewSha256 = risk.sha(fs.readFileSync(path.join(output, 'current-risk-review.json')));
    reports.boundaryTestsSha256 = risk.sha(fs.readFileSync(path.join(output, 'build-boundary-tests.stdout')));
    fs.writeFileSync(path.join(output, 'audit-status.json'), JSON.stringify(reports, null, 2) + '\n');
  }
  if (context.kind === 'local-verification' && ['strict', 'review'].includes(opts.mode)) risk.sealReview(ROOT, output, context);
  if (opts.mode === 'review') {
    if (currentDecision) {
      console.log(`Review completed: current full/production audits 0; historical advisory withdrawn; ${currentDecision.performance.timeouts} isolated timeouts; releaseEligible=${currentDecision.releaseEligible}. No risk approval or publication authorization issued.`);
      return;
    }
    risk.requireThat(full.code === 1 && !full.error && !full.signal, 'Review requires a valid vulnerability report');
    risk.checkLock(JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'))));
    risk.inspectAudit(rawAudit, JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'))));
    console.log('Review evidence collected. No exception authorized and no build allowed.'); return;
  }
  let buildInstallation;
  function recheck() {
    risk.requireThat(risk.stable(source) === risk.stable(risk.sourceState(ROOT)), 'Reviewed source changed during the controlled build');
    if (buildInstallation) risk.requireThat(buildInstallation === risk.installationState(ROOT), 'Installed dependencies changed during tests or distribution');
    if (!envelope) return;
    risk.requireThat(!fs.existsSync(path.join(ledger, `${envelope.statement.id}.revoked.json`)), 'Authorization revoked during build');
    if (context.kind === 'github') risk.requireThat(process.env.N7M_RISK_REVOKED === 'false', 'GitHub authorization missing or revoked');
    approval = risk.evaluate({ root: ROOT, rawAudit, envelope, publicKey, context });
    if (receipt) {
      const current = JSON.parse(fs.readFileSync(path.join(ledger, `${envelope.statement.id}.consumed.json`)));
      risk.requireThat(risk.stable(current) === risk.stable(receipt), 'Durable consumption receipt changed or was rolled back');
    }
  }
  if (opts.mode === 'strict') {
    if (currentDecision) risk.requireThat(currentDecision.guardedBuildEligible, 'Current audit is clean, but the separate performance-risk gate remains blocked; see current-risk-review.json');
    must(full); if (!currentDecision) must(probes);
    const parsed = JSON.parse(rawAudit);
    risk.requireThat(parsed.auditReportVersion === 2 && !parsed.error && parsed.metadata?.vulnerabilities?.total === 0, 'Strict audit must be clean');
  } else {
    risk.requireThat(full.code === 1 && !full.error && !full.signal, 'Audit execution failure cannot be accepted');
    risk.requireThat(probes.code === 1 && !probes.error && !probes.signal, 'Probe execution failure cannot be accepted');
    // Compare the fresh isolated report structurally, ignoring only elapsed time.
    const current = JSON.parse(fs.readFileSync(path.join(output, 'picomatch-probes.stdout')));
    const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, 'security-audit/2026-11-18/picomatch-installed-probes.json')));
    const shape = value => JSON.parse(JSON.stringify(value, (key, item) => key === 'milliseconds' ? undefined : item));
    risk.requireThat(risk.stable(shape(current)) === risk.stable(shape(baseline)), 'Isolated probe findings or execution changed');
    recheck();
    receipt = risk.consume(ledger, envelope.statement);
    fs.writeFileSync(path.join(output, 'consumption-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
    fs.writeFileSync(path.join(output, 'risk-decision.json'), JSON.stringify(approval, null, 2) + '\n');
    console.log(`ONE-RUN ACCEPTED BUILD-TIME RISK: ${risk.ADVISORY}; ${approval.count} high findings remain; NOT FIXED.`);
  }
  recheck(); must(step('electron-runtime', [path.join(ROOT, 'node_modules/electron/install.js')]));
  buildInstallation = risk.installationState(ROOT);
  recheck(); must(npm('tests', ['test']));
  recheck();
  const artifactDirectory = path.join(ROOT, 'release', `controlled-${context.runId}`);
  risk.requireThat(!fs.existsSync(artifactDirectory), 'Artifact output already exists; refuse overwrite');
  const distribution = require('./guarded-distribution.cjs').build(artifactDirectory, output);
  recheck(); must(step('verify-artifacts', [path.join(ROOT, 'build/verify-release.cjs'), '--output', artifactDirectory, '--report', path.join(output, 'artifact-verification.json')]));
  recheck();
  const result = { ...reports, completedAt: new Date().toISOString(), artifactDirectory, riskDecision: approval || { mode: 'strict', acceptedRisk: false },
    distribution, installationSha256: buildInstallation, lockSha256: risk.sha(fs.readFileSync(path.join(ROOT, 'package-lock.json'))),
    releaseEligible: true, publicationAuthorized: false, authorizationConsumed: !!envelope, vulnerabilityFixed: false };
  fs.writeFileSync(path.join(output, 'build-result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log('Verified build completed. Publication is a separate explicit decision.');
}
module.exports = { options, cleanEnvironment, contextFromEnvironment, main };
if (require.main === module) main().catch(error => { console.error(`CONTROLLED BUILD REFUSED: ${error.message}`); process.exitCode = 1; });
