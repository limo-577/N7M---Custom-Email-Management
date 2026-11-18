'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { attacks } = require('../build/picomatch-probe.cjs');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'n7m-guard-'));
test.after(() => fs.rmSync(directory, { recursive: true, force: true }));
const root = path.resolve(__dirname, '..');
function run(script) {
  return spawnSync(process.execPath, ['--require', path.join(root, 'build/glob-build-guard.cjs'), '-e', script], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000,
    env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', N7M_GLOB_GUARD_LOG: path.join(directory, 'guard.jsonl') }
  });
}
for (const location of Object.keys(require('../build/risk-acceptance.cjs').EXPECTED)) {
  test(`CJS and ESM ${location} reject all attack patterns before regex execution and preserve supported controls`, () => {
    const entry = path.join(root, location, 'index.js');
    const privateEntry = path.join(root, location, 'lib/parse.js');
    const internalEntry = path.join(root, location, 'lib/picomatch.js');
    for (const esmFirst of [false, true]) {
    const result = run(`(async()=>{const assert=require('node:assert/strict');${esmFirst ? `await import(require('node:url').pathToFileURL(${JSON.stringify(entry)}));` : ''}for(const pm of [require(${JSON.stringify(entry)}),(await import(require('node:url').pathToFileURL(${JSON.stringify(entry)})).then(m=>m.default)),require(${JSON.stringify(internalEntry)}),(await import(require('node:url').pathToFileURL(${JSON.stringify(internalEntry)})).then(m=>m.default))]) {
      for(const a of ${JSON.stringify(attacks)})assert.throws(()=>pm.makeRe(a.pattern,a.options),{code:'BUILD_GLOB_REFUSED'});
      for(const [pattern,input,expected] of [['**/*.js','src/a.js',true],['**/*.js','.hidden/a.js',false],['**/*.{js,jsx,ts,tsx}','src/a.tsx',true],['a/*.txt','a/b/c.txt',false]])assert.equal(pm(pattern)(input),expected);
      for(const pattern of ['*a*b','+(a)','{{a,b},c}','{1..99999}','a'.repeat(513)])assert.throws(()=>pm(pattern),{code:'BUILD_GLOB_REFUSED'});
      assert.throws(()=>pm('*.js')('a'.repeat(4097)),{code:'BUILD_GLOB_REFUSED'});
      assert.throws(()=>pm.toRegex('(a+)+$'),{code:'BUILD_GLOB_REFUSED'});
      assert.throws(()=>pm.makeRe('*',{prepend:'(a+)+'}),{code:'BUILD_GLOB_REFUSED'});
    }
    assert.throws(()=>require(${JSON.stringify(privateEntry)}),{code:'BUILD_GLOB_REFUSED'});
    await assert.rejects(import(require('node:url').pathToFileURL(${JSON.stringify(privateEntry)})),{code:'BUILD_GLOB_REFUSED'});
    console.log('guarded');})().catch(e=>{console.error(e);process.exitCode=1})`);
    assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), 'guarded');
    }
  });
}
