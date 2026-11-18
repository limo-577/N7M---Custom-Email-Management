'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
function boundedStep({ name, executable = process.execPath, args, output, env, cwd, timeout = 600000,
  processMiB = 2048, jobMiB = 6144, cpuSeconds = 600 }) {
  if (process.platform !== 'win32') throw Error('Windows build job containment is required; no uncontained fallback');
  if (![timeout, processMiB, jobMiB, cpuSeconds].every(Number.isInteger) || timeout < 100 || timeout > 1200000 || processMiB < 64 || processMiB > 2048 || jobMiB < processMiB || jobMiB > 6144 || cpuSeconds < 1 || cpuSeconds > 600) throw Error('Invalid resource budget');
  const request = path.join(output, `${name}.job-request.json`);
  const settings = { executable, args, cwd, stdout: path.join(output, `${name}.stdout`), stderr: path.join(output, `${name}.stderr`), timeout, processMiB, jobMiB, cpuSeconds };
  fs.writeFileSync(request, JSON.stringify(settings), { flag: 'wx' });
  const shell = path.join(env.SystemRoot || env.SYSTEMROOT || process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const child = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-File', path.join(__dirname, 'windows-build-job.ps1'), '-Request', request],
    { cwd, env, windowsHide: true, encoding: 'utf8', timeout: timeout + 60000, maxBuffer: 1024 * 1024 });
  fs.writeFileSync(path.join(output, `${name}.launcher.stderr`), child.stderr || '', { flag: 'wx' });
  if (child.status !== 0 || child.error || child.signal) throw Error(`Job launcher failed closed: ${child.error?.code || child.status}; ${child.stderr}`);
  const result = JSON.parse(child.stdout.replace(/^\uFEFF/, ''));
  if (result.assignedBeforeStart !== true || result.killDescendantsOnClose !== true || !Number.isInteger(result.code)) throw Error('Missing job containment evidence');
  fs.writeFileSync(path.join(output, `${name}.containment.json`), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  return { status: result.code, error: result.code === 124 ? { code: 'JOB_DEADLINE' } : undefined, signal: null, containment: result };
}
module.exports = { boundedStep };
