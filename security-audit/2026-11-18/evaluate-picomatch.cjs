'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { probe, attacks } = require('../../build/picomatch-probe.cjs');
const root = path.resolve(__dirname, '../..');
const scratch = path.join(root, 'test-results/picomatch-candidates');
fs.mkdirSync(scratch, { recursive: true });
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
// Apply only the reviewed parser hunks, retaining the published version's other
// behavior. Never replace v2 with v4 or mutate node_modules.
function patchParser(source, diff) {
  const parserDiff = diff.split('diff --git a/lib/parse.js b/lib/parse.js\n')[1]?.split('\ndiff --git ')[0];
  assert.ok(parserDiff, 'Missing parser diff');
  for (const block of parserDiff.split(/^@@ .*@@.*\n/m).slice(1)) {
    const lines = block.split('\n').filter(line => /^[ +\-]/.test(line));
    const before = lines.filter(line => line[0] !== '+').map(line => line.slice(1)).join('\n') + '\n';
    const after = lines.filter(line => line[0] !== '-').map(line => line.slice(1)).join('\n') + '\n';
    assert.equal(source.split(before).length, 2, 'Patch context must occur exactly once');
    source = source.replace(before, after);
  }
  return source;
}
const legalCases = [
  { pattern: '+(*)c', input: 'abc' },
  { pattern: '*(a*|b)', input: 'ax' },
  { pattern: '+(*a)', input: 'aaa', options: { capture: true } },
  { pattern: '+(a*b)', input: 'abab' },
  { pattern: '+(a*| b)', input: 'ab' },
  { pattern: '+(*a|b)', input: 'aba' },
  { pattern: '+(*a)', input: 'aba', options: { capture: true } },
  { pattern: '+(js|jsx)', input: 'jsxjs' },
  { pattern: '**/*.js', input: 'src/a.js' },
  { pattern: '+(a*b*c*d*e*f*g*h*)z', input: 'abcdefghz' }
];
const results = [];
for (const [id, major] of [[235, 4], [254, 4], [257, 4], [262, 4], [263, 2]]) {
  const original = path.join(root, major === 2 ? 'node_modules/picomatch' : 'node_modules/vite/node_modules/picomatch');
  const candidate = path.join(scratch, `pr-${id}`);
  fs.mkdirSync(candidate, { recursive: true });
  for (const file of ['index.js', 'package.json', 'LICENSE']) fs.copyFileSync(path.join(original, file), path.join(candidate, file));
  fs.cpSync(path.join(original, 'lib'), path.join(candidate, 'lib'), { recursive: true });
  const source = fs.readFileSync(path.join(original, 'lib/parse.js'), 'utf8').replace(/\r\n/g, '\n');
  const diff = fs.readFileSync(path.join(__dirname, `pr-${id}.diff`), 'utf8').replace(/\r\n/g, '\n');
  const patched = patchParser(source, diff);
  fs.writeFileSync(path.join(candidate, 'lib/parse.js'), patched);
  const baseline = probe(original, legalCases);
  const changed = probe(candidate, legalCases);
  assert.equal(baseline.error, null); assert.equal(changed.error, null);
  const compatibilityChanges = legalCases.flatMap((value, index) => JSON.stringify(baseline.results[index]) === JSON.stringify(changed.results[index]) ? [] : [{ ...value, before: baseline.results[index], after: changed.results[index] }]);
  const hostile = attacks.map(value => ({ pattern: value.pattern, options: value.options || {}, ...probe(candidate, [value], { timeout: 1000 }) }));
  // A restricted collapse can still leave polynomial backtracking in a branch
  // containing many independent stars, even when outer repetition is removed.
  hostile.push({ pattern: '+(a*a*a*a*a*a*a*a*)b', ...probe(candidate, [{ pattern: '+(a*a*a*a*a*a*a*a*)b', input: 'a'.repeat(150) + '!' }], { timeout: 1000 }) });
  const result = { pr: id, major, ...JSON.parse(fs.readFileSync(path.join(__dirname, `pr-${id}.json`))),
    sourceSha256: hash(source), patchedSha256: hash(patched), compatibilityChanges, hostile,
    accepted: compatibilityChanges.length === 0 && hostile.every(run => !run.error && run.status === 0 && run.results?.[0]?.matched === false) };
  results.push(result);
  fs.writeFileSync(path.join(__dirname, 'candidate-evaluation.json'), JSON.stringify(results, null, 2) + '\n');
  console.log(JSON.stringify({ pr: id, compatibilityChanges: compatibilityChanges.length, timeouts: hostile.filter(run => run.error).map(run => run.pattern), accepted: result.accepted }));
}
