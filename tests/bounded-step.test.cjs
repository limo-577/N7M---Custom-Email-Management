'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { boundedStep } = require('../build/bounded-step.cjs');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'n7m-job-'));
test.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
function run(name, script, options = {}) {
  return boundedStep({ name, args: ['-e', script], cwd: temporary, output: temporary, env: process.env, ...options });
}
test('job wrapper preserves literal arguments and reports enforced process-tree limits', { skip: process.platform !== 'win32' }, () => {
  const args = ['spaces here', 'a"b', 'C:\\space here\\', '$(not-a-shell)', '汉字 📁'];
  const result = run('arguments', 'console.log(JSON.stringify(process.argv.slice(1)))', { args: ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', ...args] });
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(temporary, 'arguments.stdout'))), args);
  assert.equal(result.containment.assignedBeforeStart, true); assert.equal(result.containment.killDescendantsOnClose, true);
  assert.equal(result.containment.activeProcessLimit, 64);
});
test('wall deadline kills a blocked root and its child, without blocking the test process', { skip: process.platform !== 'win32' }, () => {
  const result = run('deadline', `const c=require('node:child_process').spawn(process.execPath,['-e','while(true){}'],{stdio:'ignore'});console.log(c.pid);while(true){}`, { timeout: 1000 });
  assert.equal(result.status, 124); assert.equal(result.error.code, 'JOB_DEADLINE');
  const pid = Number(fs.readFileSync(path.join(temporary, 'deadline.stdout'), 'utf8').trim()); assert.ok(pid > 0);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});
test('normal root exit also kills orphaned descendants', { skip: process.platform !== 'win32' }, () => {
  const result = run('orphan', `const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);c.unref()`);
  assert.equal(result.status, 0);
  const pid = Number(fs.readFileSync(path.join(temporary, 'orphan.stdout'), 'utf8').trim()); assert.ok(pid > 0);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});
test('aggregate CPU budget terminates an infinite loop before the wall deadline', { skip: process.platform !== 'win32' }, () => {
  const result = run('cpu', 'while(true){}', { cpuSeconds: 1, timeout: 30000 });
  assert.notEqual(result.status, 0); assert.notEqual(result.status, 124);
});
test('committed-memory budget refuses allocation growth and cannot be raised by caller options', { skip: process.platform !== 'win32' }, () => {
  const result = run('memory', `const items=[];for(let i=0;i<100;i++)items.push(Buffer.alloc(16*1024*1024,1));process.exit(0)`, { processMiB: 128, jobMiB: 256, timeout: 10000 });
  assert.notEqual(result.status, 0); assert.notEqual(result.status, 124);
  assert.throws(() => run('oversized', '', { jobMiB: 65536 }), /Invalid resource budget/);
});
