'use strict';
const { spawnSync } = require('node:child_process');

// Both compilation and matching stay in a disposable process. A timer inside
// that process cannot interrupt a synchronous RegExp execution.
function probe(modulePath, cases, { timeout = 2000 } = {}) {
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 10000) throw Error('Probe timeout must be 100..10000 milliseconds');
  // A preload must never replace the real matcher and turn a raw regression
  // into a misleading success. Match compilation remains in this child only.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['NODE_OPTIONS', 'NODE_PATH'].includes(key.toUpperCase())));
  const script = `
    const pm = require(process.argv[1]);
    const cases = JSON.parse(process.argv[2]);
    const results = cases.map(({pattern, input, options}) => {
      const re = pm.makeRe(pattern, options || {});
      const match = re.exec(input);
      return { matched: !!match, captures: match ? match.slice(1) : null };
    });
    process.stdout.write(JSON.stringify(results));
  `;
  const start = performance.now();
  const child = spawnSync(process.execPath, ['--max-old-space-size=128', '-e', script, modulePath, JSON.stringify(cases)], {
    env, timeout, killSignal: 'SIGKILL', windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024
  });
  const result = { milliseconds: Math.round(performance.now() - start), status: child.status, signal: child.signal,
    error: child.error?.code || null, stderr: child.stderr || '' };
  if (!child.error && child.status === 0) {
    try { result.results = JSON.parse(child.stdout); }
    catch { result.error = 'INVALID_CHILD_OUTPUT'; }
  }
  return result;
}

const attacks = [
  { pattern: '+(*a)', input: 'a'.repeat(45) + '!' },
  { pattern: '+(*)b', input: 'a'.repeat(45) + '/' },
  { pattern: '+(a*)b', input: 'a'.repeat(45) + '/' },
  { pattern: '+(*a|b)b', input: 'a'.repeat(45) + '!' },
  { pattern: '+(@(*a))', input: 'a'.repeat(45) + '!' },
  { pattern: '+(*a)', input: 'a'.repeat(45) + '!', options: { capture: true } },
  { pattern: '+([*a)', input: '[a'.repeat(45) + '!' },
  { pattern: '+([*a])', input: '[a]'.repeat(45) + '!', options: { nobracket: true } }
];
module.exports = { probe, attacks };
