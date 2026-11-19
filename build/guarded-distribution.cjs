'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { boundedStep } = require('./bounded-step.cjs');
const risk = require('./risk-acceptance.cjs');
const { cleanEnvironment } = require('./controlled-build.cjs');
const { outputPath, reportPath } = require('./release-paths.cjs');
const ROOT = path.resolve(__dirname, '..');
function build(output, evidence) {
  risk.checkInputs(ROOT);
  output = outputPath(ROOT, output, process.cwd()); evidence = reportPath(ROOT, evidence, process.cwd());
  risk.requireThat(!fs.existsSync(output) || fs.readdirSync(output).length === 0, 'Distribution output must be empty; refuse to overwrite packages');
  const log = path.join(evidence, 'glob-guard.jsonl');
  risk.requireThat(!fs.existsSync(log), 'Glob evidence already exists');
  const env = cleanEnvironment();
  env.NPM_CONFIG_USERCONFIG = path.join(evidence, 'distribution-empty.npmrc');
  env.NPM_CONFIG_GLOBALCONFIG = path.join(evidence, 'distribution-empty-global.npmrc');
  fs.writeFileSync(env.NPM_CONFIG_USERCONFIG, '', { flag: 'wx' }); fs.writeFileSync(env.NPM_CONFIG_GLOBALCONFIG, '', { flag: 'wx' });
  env.N7M_GLOB_GUARD_LOG = log;
  env.NODE_OPTIONS = `--require="${path.join(ROOT, 'build/glob-build-guard.cjs').replaceAll('\\', '/')}"`;
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  const child = boundedStep({ name: 'guarded-distribution', args: [npmCli, 'run', 'dist:all', '--', '--output', output], output: evidence, env, cwd: ROOT, timeout: 1200000 });
  risk.requireThat(child.status === 0 && !child.error, 'Guarded distribution failed; raw stdout/stderr and limits retained');
  const events = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  risk.requireThat(!events.some(value => value.rejected), 'A build glob was rejected, including if a dependency caught the error');
  const observed = [...new Set(events.filter(value => value.guardedModule).map(value => path.relative(ROOT, value.guardedModule).replaceAll('\\', '/').replace(/\/(?:lib\/picomatch|index)\.js$/, '')))].sort();
  risk.requireThat(risk.stable(observed) === risk.stable(Object.keys(risk.EXPECTED).sort()), 'Actual CJS/ESM matcher coverage is incomplete or contains a new installation');
  const invoked = [...new Set(events.filter(value => value.validatedModule).map(value => path.relative(ROOT, value.validatedModule).replaceAll('\\', '/').replace(/\/(?:lib\/picomatch|index)\.js$/, '')))].sort();
  risk.requireThat(risk.stable(invoked) === risk.stable(observed), 'Matcher input validation was not observed for every installation');
  const result = { completedAt: new Date().toISOString(), observed, invoked, rejectedPatterns: 0, rawMatcherFixed: false,
    guardEvidenceSha256: risk.sha(fs.readFileSync(log)), containment: child.containment, publicationAuthorized: false };
  fs.writeFileSync(path.join(evidence, 'guarded-distribution.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  return result;
}
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    risk.requireThat(args.length === 0, 'CI guarded distribution accepts no external pattern or command arguments');
    const source = risk.sourceState(ROOT);
    const evidence = path.join(ROOT, '.risk-build/strict-release/distribution-' + crypto.randomUUID()); fs.mkdirSync(evidence, { recursive: true });
    build(path.join(ROOT, 'release'), evidence);
    risk.requireThat(risk.stable(source) === risk.stable(risk.sourceState(ROOT)), 'Reviewed source changed during distribution');
    console.log(`Guarded distribution evidence: ${evidence}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { build };
