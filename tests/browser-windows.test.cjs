const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { createBrowserWindows, normalizeWindow, windowKey, newWindows } = require('../electron/browser-windows.cjs');
const TOKEN = '12345678-1234-4234-8234-123456789abc';
const candidate = (patch = {}) => ({ hwnd: '1234567', pid: 1234, processStartedAt: '638999900000000000',
  executable: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', appId: 'Chrome.Profile_1', profile: 'Profile 1', ...patch });
const tagged = patch => ({ ...candidate(patch), token: TOKEN });
test('Firefox window identities use the same exact HWND, process lifetime and random ownership marker checks', async () => {
  const firefox = tagged({ executable: 'C:\\Program Files\\Mozilla Firefox\\firefox.exe', profile: '' });
  assert.equal(normalizeWindow(firefox, true).executable, firefox.executable);
  const api = createBrowserWindows({ platform: 'win32', execute: async request => {
    assert.equal(request.records[0].executable, firefox.executable);
    return { ok: true, results: [{ state: request.action === 'close' ? 'requested' : 'alive' }] };
  } });
  assert.deepEqual((await api.inspect([firefox])).alive, [normalizeWindow(firefox, true)]);
  assert.deepEqual((await api.closeWindows([firefox])).requested, [normalizeWindow(firefox, true)]);
  const script = fs.readFileSync(path.join(__dirname, '../electron/browser-windows.ps1'), 'utf8');
  assert.ok(script.includes('name.Equals("firefox.exe", StringComparison.OrdinalIgnoreCase)'));
  assert.ok(script.includes('name.ToString() == "MozillaWindowClass"'));
});

test('window identities preserve 64-bit handles and strip titles, URLs and unrelated fields', () => {
  const normalized = normalizeWindow({ ...tagged({ hwnd: '9007199254740993' }), title: 'private title', url: 'https://private.example/', password: 'private password' }, true);
  assert.equal(normalized.hwnd, '9007199254740993');
  assert.equal(normalized.token, TOKEN);
  for (const name of ['title', 'url', 'password']) assert.equal(Object.hasOwn(normalized, name), false);
  assert.equal(windowKey(candidate()), windowKey(candidate({ executable: 'c:\\PROGRAM FILES\\Google\\Chrome\\Application\\chrome.exe' })));
  assert.notEqual(windowKey(candidate()), windowKey(candidate({ processStartedAt: '638999900000000001' })));
});

test('window metadata preserves plus Profile names without turning them into spaces', () => {
  assert.equal(normalizeWindow(candidate({ profile: 'Profile+21' })).profile, 'Profile+21');
  assert.equal(normalizeWindow(candidate({ profile: 'Profile 21' })).profile, 'Profile 21');
  for (const profile of ['../Profile+21', 'Profile+21" --evil', 'Profile+21\n']) {
    assert.equal(Object.hasOwn(normalizeWindow(candidate({ profile })), 'profile'), false);
  }
});

test('unsafe or incomplete window identities are rejected before any native operation', async () => {
  let calls = 0;
  const api = createBrowserWindows({ platform: 'win32', execute: async () => { calls++; throw new Error('should not execute'); } });
  for (const patch of [{ hwnd: '0' }, { hwnd: '-1' }, { hwnd: '9223372036854775808' }, { pid: 1.5 }, { pid: 0 },
    { processStartedAt: '' }, { executable: 'chrome.exe' }, { executable: 'C:\\Windows\\notepad.exe' },
    { token: '' }, { token: 'not-a-guid' }, { token: '12345678-1234-1234-8234-123456789abc' }]) {
    await assert.rejects(api.closeWindows([{ ...tagged(), ...patch }]), /标识|标记/);
  }
  await assert.rejects(api.closeWindows([tagged(), candidate()]), /标记/);
  assert.equal(calls, 0);
});

test('new-window detection excludes pre-existing and different-browser windows and respects process restart identity', () => {
  const before = [candidate(), candidate({ hwnd: '7654321' })];
  const created = candidate({ hwnd: '2222222' });
  const reused = candidate({ hwnd: '7654321', processStartedAt: '638999900000000001' });
  const other = candidate({ hwnd: '3333333', executable: 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe' });
  assert.deepEqual(newWindows(before, [candidate(), created, reused, other], candidate().executable), [created, reused]);
  assert.deepEqual(newWindows(before, [created], ''), []);
});

test('tagging uses a fresh native token and refuses to associate a stale candidate', async () => {
  const requests = [];
  const api = createBrowserWindows({ platform: 'win32', execute: async request => {
    requests.push(request); return { ok: true, results: [{ state: requests.length === 1 ? 'alive' : 'closed' }] };
  } });
  const source = candidate(), record = await api.tagWindow(source);
  assert.match(record.token, /^[a-f\d-]{36}$/);
  assert.equal(Object.hasOwn(source, 'token'), false);
  assert.equal(requests[0].action, 'tag'); assert.equal(requests[0].records[0].token, record.token);
  await assert.rejects(api.tagWindow(source), /窗口已改变/);
});

test('inspections distinguish closed or reused windows from inaccessible windows and deduplicate exact records', async () => {
  const records = [tagged(), tagged({ hwnd: '2222222' }), tagged({ hwnd: '3333333' })];
  const api = createBrowserWindows({ platform: 'win32', execute: async request => {
    assert.equal(request.action, 'inspect'); assert.equal(request.records.length, 3);
    return { ok: true, results: [{ state: 'alive' }, { state: 'closed' }, { state: 'unknown' }] };
  } });
  const result = await api.inspect([...records, records[0]]);
  assert.deepEqual(result, { alive: [records[0]], closed: [records[1]], unknown: [records[2]] });
});

test('requesting a normal close does not report a browser closed before its window actually disappears', async () => {
  const records = [tagged(), tagged({ hwnd: '2222222' }), tagged({ hwnd: '3333333' }), tagged({ hwnd: '4444444' })];
  const api = createBrowserWindows({ platform: 'win32', execute: async request => {
    assert.equal(request.action, 'close');
    return { ok: true, results: [{ state: 'requested' }, { state: 'closed' }, { state: 'unknown' }, { state: 'denied' }] };
  } });
  assert.deepEqual(await api.closeWindows(records), { requested: [records[0]], closed: [records[1]], remaining: [records[2], records[3]] });
});

test('native failures or malformed responses never silently erase tracked windows', async () => {
  for (const response of [null, { ok: false }, { ok: true }, { ok: true, results: [] }, { ok: true, results: [{ state: 'invented' }] }]) {
    const api = createBrowserWindows({ platform: 'win32', execute: async () => response });
    await assert.rejects(api.inspect([tagged()]));
    await assert.rejects(api.closeWindows([tagged()]));
  }
  const unsupported = createBrowserWindows({ platform: 'linux', execute: async () => { throw new Error('should not run'); } });
  await assert.rejects(unsupported.snapshot(), /仅支持 Windows/);
});

test('native helper compiles and handles an empty inspection without creating or operating on windows', { skip: process.platform !== 'win32', timeout: 15000 }, async () => {
  const script = fs.readFileSync(path.join(__dirname, '../electron/browser-windows.ps1'), 'utf8');
  const result = await new Promise((resolve, reject) => {
    const file = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = execFile(file, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', '[Console]::InputEncoding = [Text.UTF8Encoding]::new($false); $envelope = [Console]::In.ReadToEnd() | ConvertFrom-Json; & ([ScriptBlock]::Create([string]$envelope.source)) $envelope.request'], {
      windowsHide: true, timeout: 12000, maxBuffer: 1024 * 1024
    }, (error, stdout) => { if (error) reject(error); else resolve(JSON.parse(stdout.trim())); });
    child.stdin.end(JSON.stringify({ source: script, request: { action: 'inspect', records: [] } }));
  });
  assert.deepEqual(result, { ok: true, results: [] });
});
