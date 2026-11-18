'use strict';
// The full audit step retains its actual exit status. This collector retains the
// raw diagnostic exit 1 separately, and makes an explicit guarded-build decision.
const fs = require('node:fs');
const path = require('node:path');
const { boundedStep } = require('./bounded-step.cjs');
const risk = require('./risk-acceptance.cjs');
const { cleanEnvironment } = require('./controlled-build.cjs');
const policy = require('./current-risk-review.cjs');
const ROOT = path.resolve(__dirname, '..');
function main() {
  risk.requireThat(process.argv.length === 2, 'No external glob or command arguments are accepted');
  const source = risk.sourceState(ROOT); risk.checkInputs(ROOT);
  const output = path.join(ROOT, '.risk-build/strict-release'); fs.mkdirSync(output, { recursive: true });
  const env = cleanEnvironment();
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  const run = (name, args, timeout) => {
    const startedAt = new Date().toISOString();
    const child = boundedStep({ name, args, output, env, cwd: ROOT, timeout });
    const result = { name, startedAt, finishedAt: new Date().toISOString(), code: child.status, signal: child.signal, error: child.error?.code || null, containment: child.containment };
    fs.appendFileSync(path.join(output, 'commands.jsonl'), JSON.stringify(result) + '\n'); return result;
  };
  const full = JSON.parse(fs.readFileSync(path.join(output, 'audit-full.result.json')));
  const production = run('audit-production', [npmCli, 'audit', '--omit=dev', '--audit-level=low', '--json']);
  const probes = run('picomatch-probes', [path.join(ROOT, 'build/check-picomatch.cjs')], 90000);
  const protection = run('build-boundary-tests', ['--test', '--test-reporter=tap', 'tests/glob-build-guard.test.cjs', 'tests/bounded-step.test.cjs']);
  const result = policy.review({ root: ROOT, full, production, probes, protection,
    rawAudit: fs.readFileSync(path.join(output, 'npm-audit-raw.json')), rawProduction: fs.readFileSync(path.join(output, 'audit-production.stdout')),
    rawProbes: fs.readFileSync(path.join(output, 'picomatch-probes.stdout')), protectionOutput: fs.readFileSync(path.join(output, 'build-boundary-tests.stdout')) });
  fs.writeFileSync(path.join(output, 'current-risk-review.json'), JSON.stringify({ ...result, source }, null, 2) + '\n', { flag: 'wx' });
  risk.requireThat(result.guardedBuildEligible, 'Guarded build conditions not met');
  console.log(`Audit 0; advisory withdrawn; raw probe exit ${probes.code}; ${result.performance.timeouts} timeouts retained; guarded-build conditions verified.`);
}
if (require.main === module) { try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { main };
