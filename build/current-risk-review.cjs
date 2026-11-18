'use strict';
// Audit classification is independent of the executable performance gate.
const fs = require('node:fs');
const path = require('node:path');
const risk = require('./risk-acceptance.cjs');
const { attacks } = require('./picomatch-probe.cjs');
const ADVISORY_URL = 'https://api.github.com/advisories/GHSA-fc5q-39xc-vjpf';
function cleanAudit(bytes, command) {
  const report = JSON.parse(bytes);
  risk.requireThat(command?.code === 0 && !command.error && !command.signal, 'Audit command did not complete successfully');
  risk.requireThat(report.auditReportVersion === 2 && !report.error && report.vulnerabilities &&
    Object.keys(report.vulnerabilities).length === 0, 'Unknown or current audit findings block the clean-audit route');
  const counts = report.metadata?.vulnerabilities;
  risk.requireThat(counts && ['info', 'low', 'moderate', 'high', 'critical', 'total'].every(key => counts[key] === 0), 'Audit counts must all be zero');
  return report;
}
function withdrawal(root, now = Date.now()) {
  const directory = path.join(root, 'security-audit/2026-11-18-withdrawal');
  const raw = fs.readFileSync(path.join(directory, 'advisory.raw.json'));
  const retrieval = JSON.parse(fs.readFileSync(path.join(directory, 'retrieval.json'), 'utf8').replace(/^\uFEFF/, ''));
  const advisory = JSON.parse(raw);
  const completed = Date.parse(retrieval.completedAt), started = Date.parse(retrieval.retrievedAt), withdrawn = Date.parse(advisory.withdrawn_at);
  risk.requireThat(retrieval.url === ADVISORY_URL && retrieval.sha256 === risk.sha(raw), 'Withdrawal evidence hash or origin changed');
  risk.requireThat(advisory.ghsa_id === risk.ADVISORY && advisory.cve_id === 'CVE-2026-112366' &&
    Number.isFinite(withdrawn) && withdrawn <= completed && started <= completed && completed <= now && now - completed < 7 * 86400000,
  'Withdrawal evidence is missing, stale or invalid');
  return { ghsa: advisory.ghsa_id, cve: advisory.cve_id, withdrawnAt: advisory.withdrawn_at,
    retrievedAt: retrieval.completedAt, rawSha256: risk.sha(raw), url: ADVISORY_URL,
    technicalFixEstablished: false };
}
function inspectProbes(bytes, command) {
  const report = JSON.parse(bytes);
  risk.requireThat([0, 1].includes(command?.code) && !command.error && !command.signal, 'Probe runner failed');
  risk.requireThat(report.advisory === risk.ADVISORY && typeof report.ok === 'boolean' &&
    report.findings?.length === Object.keys(risk.EXPECTED).length, 'Incomplete probe evidence');
  let timeouts = 0;
  for (const [installationPath, version] of Object.entries(risk.EXPECTED)) {
    const entry = report.findings.find(value => value.installationPath === installationPath);
    risk.requireThat(entry && entry.version === version && entry.dev === true && entry.probes?.length === attacks.length, 'Unknown dependency path/version or missing probes');
    for (let i = 0; i < attacks.length; i++) {
      const probe = entry.probes[i], attack = attacks[i];
      risk.requireThat(probe.pattern === attack.pattern && risk.stable(probe.options) === risk.stable(attack.options || {}) &&
        Number.isFinite(probe.milliseconds) && probe.milliseconds >= 0, 'Probe vectors or timing evidence changed');
      if (probe.error === 'ETIMEDOUT') {
        risk.requireThat(probe.status === null && !probe.results, 'Inconsistent timeout evidence');
        timeouts++;
      } else {
        risk.requireThat(probe.error === null && probe.status === 0 && !probe.signal && probe.results?.length === 1 &&
          probe.results[0].matched === false, 'Unexpected probe error or match');
      }
    }
  }
  risk.requireThat(report.ok === (timeouts === 0) && command.code === (report.ok ? 0 : 1), 'Probe status was misrepresented');
  return { cases: Object.keys(risk.EXPECTED).length * attacks.length, timeouts, matcherFixed: false, rawExit: command.code };
}
function review({ root, rawAudit, rawProduction, rawProbes, full, production, probes, protection, protectionOutput, now }) {
  cleanAudit(rawAudit, full); cleanAudit(rawProduction, production);
  const advisory = withdrawal(root, now);
  risk.checkLock(JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'))));
  risk.checkInputs(root);
  const performance = inspectProbes(rawProbes, probes);
  const tap = String(protectionOutput || '');
  risk.requireThat(protection?.code === 0 && !protection.error && !protection.signal &&
    protection.containment?.assignedBeforeStart === true && protection.containment?.killDescendantsOnClose === true &&
    /^# tests 8\r?$/m.test(tap) && /^# pass 8\r?$/m.test(tap) && /^# fail 0\r?$/m.test(tap) && /^# skipped 0\r?$/m.test(tap), 'Fresh, contained glob-boundary and resource-limit tests are required');
  return { schemaVersion: 1, reviewedAt: new Date(now || Date.now()).toISOString(), audit: { full: 0, production: 0 },
    advisory, performance, reviewCompleted: true, publicationAuthorized: false,
    releaseEligible: false, guardedBuildEligible: true,
    reachability: { repositoryConfigPinned: true, environmentOverridesStripped: true,
      externalGlobInputInReviewedConfiguration: false, arbitraryMatcherSafetyProven: false,
      mandatoryBuildOnlyGlobRestriction: true, mandatoryWindowsProcessTreeContainment: true },
    blockers: [],
    protection: { tests: 8, stdoutSha256: risk.sha(protectionOutput), containment: protection.containment,
      releaseConditions: ['Distribution must inherit the restrictive glob preload', 'All three actual matcher installations must be observed guarded',
        'No rejected pattern, command failure, resource-limit failure or unknown dependency is allowed', 'All three final archives must pass static payload inspection'] },
    historicalEvidence: 'security-audit/2026-11-18 (unchanged; historical 18 high is not the current audit)',
    riskAcceptance: { automatic: false, withdrawnAdvisoryAuthorizationApplicable: false,
      requiredBeforeException: ['Any request to relax the enforced input/resource boundary needs a separate performance-risk policy review', 'Demonstrated enforcement and resource containment for every real build path',
        'Fresh commit/lock/install/audit/probe evidence', 'Explicit independent approval, maximum seven days, one run, separate durable ledger'] } };
}
module.exports = { cleanAudit, withdrawal, inspectProbes, review };
