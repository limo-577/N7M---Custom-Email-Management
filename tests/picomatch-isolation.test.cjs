'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { probe } = require('../build/picomatch-probe.cjs');

test('glob regression runner forcibly terminates blocked compilation in a child', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'n7m-glob-'));
  try {
    const file = path.join(dir, 'blocked.cjs');
    fs.writeFileSync(file, 'exports.makeRe = () => { while (true) {} };');
    const result = probe(file, [{ pattern: '*', input: 'x' }], { timeout: 500 });
    assert.equal(result.error, 'ETIMEDOUT');
    assert.equal(result.results, undefined);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('both installed picomatch major lines preserve ordinary glob and capture behavior', () => {
  const cases = [
    { pattern: '**/*.js', input: 'src/a.js' },
    { pattern: '**/*.js', input: '.hidden/a.js' },
    { pattern: '+(js|jsx)', input: 'jsxjs' },
    { pattern: '*(a*|b)', input: 'ax' },
    { pattern: '+(*a)', input: 'aaa', options: { capture: true } },
    { pattern: 'a/*.txt', input: 'a/b/c.txt' }
  ];
  for (const location of ['picomatch', 'vite/node_modules/picomatch', 'tinyglobby/node_modules/picomatch']) {
    const result = probe(path.resolve(__dirname, '../node_modules', location, 'index.js'), cases);
    assert.equal(result.error, null, JSON.stringify(result));
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.results.map(value => value.matched), [true, false, true, true, true, false]);
    assert.deepEqual(result.results[4].captures, ['aaa', '']);
  }
});
