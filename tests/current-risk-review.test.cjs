'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const policy = require('../build/current-risk-review.cjs');
const risk = require('../build/risk-acceptance.cjs');
const { attacks, probe } = require('../build/picomatch-probe.cjs');
const clean = () => ({ auditReportVersion: 2, vulnerabilities: {}, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } } });
const command = code => ({ code, error: null, signal: null });
const findings = () => ({ ok: false, advisory: risk.ADVISORY, findings: Object.entries(risk.EXPECTED).map(([installationPath, version]) => ({
  installationPath, version, dev: true, probes: attacks.map(attack => ({ pattern: attack.pattern, options: attack.options || {}, milliseconds: 2000, error: 'ETIMEDOUT', status: null, signal: 'SIGTERM', stderr: '' }))
})) });
test('current zero audit is accepted as zero, unknown findings and invalid executions are refused', () => {
  policy.cleanAudit(JSON.stringify(clean()), command(0));
  for (const modify of [r => { r.vulnerabilities.unknown = { severity: 'low' }; }, r => { r.metadata.vulnerabilities.high = 1; }, r => { r.error = {}; }, r => { delete r.auditReportVersion; }]) {
    const report = clean(); modify(report); assert.throws(() => policy.cleanAudit(JSON.stringify(report), command(0)));
  }
  assert.throws(() => policy.cleanAudit(JSON.stringify(clean()), command(1)));
  assert.throws(() => policy.cleanAudit(JSON.stringify(clean()), { ...command(0), error: 'ETIMEDOUT' }));
});
test('24 isolated timeouts are retained as failures, not transformed into audit findings or passing matches', () => {
  const result = policy.inspectProbes(JSON.stringify(findings()), command(1));
  assert.equal(result.timeouts, 24); assert.equal(result.matcherFixed, false); assert.equal(result.rawExit, 1);
});
test('unknown dependency paths, new versions, missing vectors and unexpected child failures are refused', () => {
  for (const modify of [r => { r.findings[0].installationPath += '/external'; }, r => { r.findings[0].version = '9.0.0'; },
    r => { r.findings[0].probes.pop(); }, r => { r.findings[0].probes[0].error = 'ENOENT'; },
    r => { r.findings[0].probes[0].pattern = 'evil'; }, r => { r.ok = true; },
    r => { r.findings[0].probes[0].results = [{ matched: false }]; }]) {
    const report = findings(); modify(report); assert.throws(() => policy.inspectProbes(JSON.stringify(report), command(1)));
  }
  assert.throws(() => policy.inspectProbes(JSON.stringify(findings()), command(0)));
});
test('withdrawal evidence hash, origin, identity and seven-day freshness are required', () => {
  const root = path.resolve(__dirname, '..');
  const retrievalTime = Date.parse(JSON.parse(fs.readFileSync(path.join(root, 'security-audit/2026-11-18-withdrawal/retrieval.json'), 'utf8').replace(/^\uFEFF/, '')).completedAt);
  const original = policy.withdrawal(root, retrievalTime + 1);
  assert.equal(original.technicalFixEstablished, false);
  assert.throws(() => policy.withdrawal(root, Date.parse(original.retrievedAt) + 7 * 86400000), /stale/);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'n7m-withdrawal-'));
  const directory = path.join(temporary, 'security-audit/2026-11-18-withdrawal'); fs.mkdirSync(directory, { recursive: true });
  try {
    for (const file of ['advisory.raw.json', 'retrieval.json']) fs.copyFileSync(path.join(root, 'security-audit/2026-11-18-withdrawal', file), path.join(directory, file));
    fs.appendFileSync(path.join(directory, 'advisory.raw.json'), ' ');
    assert.throws(() => policy.withdrawal(temporary, retrievalTime + 1), /hash/);
    const retrieval = JSON.parse(fs.readFileSync(path.join(directory, 'retrieval.json'), 'utf8').replace(/^\uFEFF/, ''));
    retrieval.sha256 = risk.sha(fs.readFileSync(path.join(directory, 'advisory.raw.json'))); retrieval.url = 'https://evil.invalid';
    fs.writeFileSync(path.join(directory, 'retrieval.json'), JSON.stringify(retrieval));
    assert.throws(() => policy.withdrawal(temporary, retrievalTime + 1), /origin/);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});
test('raw isolated probes strip hostile Node preload injection and reject an unbounded deadline', () => {
  const previous = process.env.NODE_OPTIONS;
  try {
    process.env.NODE_OPTIONS = '--require=missing-malicious-preload.cjs';
    const result = probe(require.resolve('picomatch'), [{ pattern: '*.js', input: 'a.js' }]);
    assert.equal(result.status, 0, result.stderr); assert.equal(result.results[0].matched, true);
    for (const timeout of [0, Infinity, 999999, -1]) assert.throws(() => probe(require.resolve('picomatch'), [], { timeout }));
  } finally { if (previous === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previous; }
});
