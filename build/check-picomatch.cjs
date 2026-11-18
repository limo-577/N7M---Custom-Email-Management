'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { probe, attacks } = require('./picomatch-probe.cjs');
const root = path.resolve(__dirname, '..');
function check() {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json')));
  const entries = Object.entries(lock.packages).filter(([key, value]) => key && (value.name || key.split('node_modules/').at(-1)) === 'picomatch');
  if (!entries.length) throw Error('No picomatch installation found; review the dependency graph explicitly.');
  const findings = entries.map(([installationPath, entry]) => ({
    installationPath, version: entry.version, dev: entry.dev === true,
    probes: attacks.map(attack => ({ pattern: attack.pattern, options: attack.options || {}, ...probe(path.join(root, installationPath), [attack]) }))
  }));
  const ok = findings.every(entry => entry.probes.every(run => !run.error && run.status === 0 && run.results?.[0]?.matched === false));
  return { ok, advisory: 'GHSA-fc5q-39xc-vjpf', scope: 'Regression vectors only; passing is not proof of general RegExp safety.', findings };
}
if (require.main === module) {
  try { const result = check(); console.log(JSON.stringify(result, null, 2)); process.exitCode = result.ok ? 0 : 1; }
  catch (error) { console.error(error); process.exitCode = 1; }
}
module.exports = { check };
