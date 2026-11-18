'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const { createBrowserWindows } = require('../electron/browser-windows.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(check, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  do { const value = await check(); if (value) return value; await delay(50); } while (Date.now() < deadline);
  throw new Error('Owned background fixture did not reach the expected state');
}

test('native HWND identity, tagging, exact-window close and external-close observation preserve a sibling window',
  { skip: process.platform !== 'win32' ? 'Windows native fixture only' : process.env.N7M_NATIVE_WINDOWS_TEST !== '1'
    ? 'Opt-in: set N7M_NATIVE_WINDOWS_TEST=1 for the owned offscreen PowerShell-hosted native fixture' : false,
    timeout: 90000 }, async () => {
    const root = path.resolve(__dirname, '..');
    // Playwright clears test-results when its independent desktop suite starts.
    // Keep native process fixtures outside that cleanup tree while they run.
    const results = path.join(root, 'tmp'); fs.mkdirSync(results, { recursive: true });
    const directory = fs.mkdtempSync(path.join(results, 'native-browser-窗口-'));
    const host = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    assert.ok(fs.existsSync(host), 'Windows PowerShell is required for native QA');
    // This path is only an adapter-facing alias. No browser EXE is written,
    // renamed or executed; the fixture runs in the normal signed system host.
    const executable = path.join(directory, 'chrome.exe');
    const readyFile = path.join(directory, 'ready.json'), commandFile = path.join(directory, 'command.txt');
    const fixtureCommand = '$ErrorActionPreference="Stop"; try { Add-Type -TypeDefinition ([IO.File]::ReadAllText([Environment]::GetEnvironmentVariable("N7M_FIXTURE_SOURCE"))) -Language CSharp; exit [BrowserWindowFixture]::Run([Environment]::GetEnvironmentVariable("N7M_FIXTURE_READY"),[Environment]::GetEnvironmentVariable("N7M_FIXTURE_COMMAND")) } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }';
    const child = spawn(host, ['-NoProfile', '-NonInteractive', '-STA', '-WindowStyle', 'Hidden', '-Command', fixtureCommand], {
      windowsHide: true, stdio: 'ignore', env: { ...process.env,
        N7M_FIXTURE_SOURCE: path.join(__dirname, 'fixtures', 'browser-window-fixture.cs'),
        N7M_FIXTURE_READY: readyFile, N7M_FIXTURE_COMMAND: commandFile }
    });
    let childError;
    child.once('error', error => { childError = error; });
    const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
    try {
      const ready = await until(() => {
        if (childError) throw childError;
        if (fs.existsSync(`${readyFile}.error`)) throw new Error(`Owned fixture failed: ${fs.readFileSync(`${readyFile}.error`, 'utf8')}`);
        if (child.exitCode !== null) throw new Error('Owned fixture exited before readiness');
        if (!fs.existsSync(readyFile)) return false;
        try { return JSON.parse(fs.readFileSync(readyFile, 'utf8')); } catch { return false; }
      });
      assert.equal(ready.pid, child.pid);
      assert.equal(ready.offscreen, true); assert.equal(ready.neverActivated, true);
      assert.equal(ready.handles.length, 2);
      // Test-only host adaptation: permit the exact signed PowerShell host in
      // Browser(), then restrict native Read() to this fixture PID. The actual
      // HWND/PID/start-time/SetProp/GetProp/PostMessage code is unchanged. Wire
      // executable aliases let the JS adapter retain its production allowlist.
      let source = fs.readFileSync(path.join(root, 'electron', 'browser-windows.ps1'), 'utf8');
      const browserAnchor = 'string name = Path.GetFileName(file);';
      const readAnchor = 'using (Process process = Process.GetProcessById((int)id)) {';
      assert.equal(source.split(browserAnchor).length, 2); assert.equal(source.split(readAnchor).length, 2);
      source = source.replace(browserAnchor, `${browserAnchor}\n    if (file.Equals(@"${host.replace(/"/g, '""')}", StringComparison.OrdinalIgnoreCase)) return true;`)
        .replace(readAnchor, `if (id != ${child.pid}u) return null;\n    ${readAnchor}`);
      const nativeExecute = request => new Promise((resolve, reject) => {
        if (request.records.some(record => !ready.handles.includes(record.hwnd))) return reject(new Error('Native QA cannot address an unowned HWND'));
        const scoped = { ...request, records: request.records.map(record => ({ ...record,
          executable: record.executable.toLowerCase() === executable.toLowerCase() ? host : record.executable })) };
        const command = '[Console]::InputEncoding = [Text.UTF8Encoding]::new($false); $envelope = [Console]::In.ReadToEnd() | ConvertFrom-Json; & ([ScriptBlock]::Create([string]$envelope.source)) $envelope.request';
        const helper = execFile(host, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', command],
          { windowsHide: true, timeout: 15000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' }, (error, output) => {
            if (error) return reject(new Error('Owned native helper failed'));
            try {
              const result = JSON.parse(output.replace(/^\uFEFF/, '').trim());
              if (result.windows) result.windows = result.windows.map(window => ({ ...window, executable }));
              resolve(result);
            } catch { reject(new Error('Owned native helper response is invalid')); }
          });
        helper.stdin.on('error', () => {}); helper.stdin.end(JSON.stringify({ source, request: scoped }));
      });
      const windows = createBrowserWindows({ timeoutMs: 15000, execute: nativeExecute });
      // The adapter never returns titles or URLs, and assertions only retain
      // windows owned by this exact fake process/path. No real browser closes.
      const snapshot = (await windows.snapshot()).filter(window => window.pid === child.pid && window.executable.toLowerCase() === executable.toLowerCase());
      assert.deepEqual(snapshot.map(window => window.hwnd).sort(), [...ready.handles].sort());
      assert.ok(snapshot.every(window => !Object.hasOwn(window, 'title') && !Object.hasOwn(window, 'url')));
      const tagged = [];
      for (const handle of ready.handles) tagged.push(await windows.tagWindow(snapshot.find(window => window.hwnd === handle)));
      assert.equal(new Set(tagged.map(window => window.token)).size, 2);
      assert.equal((await windows.inspect(tagged)).alive.length, 2);
      // Forged identity and tags cannot post WM_CLOSE, even though their HWND
      // points at a real sibling in this owned process.
      const forgeries = [
        { ...tagged[0], pid: tagged[0].pid + 1 },
        { ...tagged[0], processStartedAt: (BigInt(tagged[0].processStartedAt) + 1n).toString() },
        { ...tagged[0], token: crypto.randomUUID() },
        { ...tagged[0], executable: path.join(directory, 'other', 'chrome.exe') },
      ];
      const denied = await windows.closeWindows(forgeries);
      assert.equal(denied.requested.length, 0);
      assert.equal((await windows.inspect(tagged)).alive.length, 2);
      await assert.rejects(windows.tagWindow({ ...snapshot[0], pid: snapshot[0].pid + 1 }), /改变|关联/);
      const closing = await windows.closeWindows([tagged[0]]);
      assert.equal(closing.requested.length, 1);
      const firstObservation = await windows.inspect(tagged);
      assert.equal(firstObservation.closed.length, 1);
      assert.equal(firstObservation.alive.length, 1);
      assert.equal(firstObservation.alive[0].hwnd, tagged[1].hwnd);
      assert.equal(child.exitCode, null, 'closing one window must not terminate its shared browser process');
      // Simulate the user's own X-close through the fixture's private control
      // file, then let the normal inspection path discover it automatically.
      const second = tagged[1];
      assert.equal(second.hwnd, ready.handles[1]);
      fs.writeFileSync(commandFile, 'close-second');
      await until(async () => (await windows.inspect([second])).closed.length === 1, 20000);
      assert.equal((await windows.inspect(tagged)).alive.length, 0);
      assert.equal(await Promise.race([exited, delay(5000).then(() => 'timeout')]), 0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await Promise.race([exited, delay(5000)]);
    }
  });
