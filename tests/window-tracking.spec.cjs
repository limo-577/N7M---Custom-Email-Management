const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { VaultStore } = require('../electron/vault.cjs');

const root = path.resolve(__dirname, '..');
const MASTER = 'N7M-window-tracking-test123!';
let app, page;
const rowFor = email => page.locator('.accounts-table tbody tr').filter({ hasText: email });
const startFor = email => rowFor(email).getByRole('button', { name: '启动', exact: true });

function tempData(prefix) {
  fs.mkdirSync(path.join(root, 'test-results'), { recursive: true });
  return fs.mkdtempSync(path.join(root, 'test-results', prefix));
}
async function launch(directory) {
  const packaged = process.env.N7M_PACKAGED_TEST === '1';
  const packagedDirectory = process.env.N7M_PACKAGED_DIR ? path.resolve(process.env.N7M_PACKAGED_DIR) : path.join(root, 'release', 'win-unpacked');
  const env = { ...process.env, N7M_TEST_DATA_DIR: directory,
    N7M_BACKGROUND_APP_ROOT: packaged ? path.join(packagedDirectory, 'resources', 'app.asar') : root,
    N7M_BACKGROUND_PRODUCTION: packaged ? '1' : '0' };
  delete env.ELECTRON_RUN_AS_NODE;
  // This fixture hides all windows before the application's first window can
  // be created, and replaces browsers and clipboard with isolated in-memory fakes.
  app = await electron.launch({ args: [path.join(root, 'tests', 'background-electron.cjs')], env, timeout: 30000 });
  page = await app.firstWindow();
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(window => !window.isVisible()))).toBe(true);
}
async function closeApp() {
  const current = app; app = null; page = null;
  if (current) await current.close();
}
async function setup() {
  await page.getByLabel('软件密码', { exact: true }).fill(MASTER);
  await page.getByLabel('确认软件密码', { exact: true }).fill(MASTER);
  await page.getByRole('button', { name: '设置密码并解锁', exact: true }).click();
  await expect(page.getByRole('heading', { name: '全部账号', exact: true })).toBeVisible();
}
async function unlock() {
  await page.getByLabel('软件密码', { exact: true }).fill(MASTER);
  await page.getByRole('button', { name: '解锁', exact: true }).click();
  await expect(page.getByRole('heading', { name: '全部账号', exact: true })).toBeVisible();
}
async function load() {
  const result = await page.evaluate(() => window.emailManager.loadEmailData());
  expect(result.ok).toBe(true); return result.data;
}
async function fakeLauncher(mode = '') {
  await app.evaluate(({ app }, nextMode) => {
    const req = process.getBuiltinModule('module').createRequire(`${app.getAppPath()}/package.json`);
    global.__n7mSnapshotError = nextMode === 'baseline';
    global.__n7mNoNewWindow = nextMode === 'timeout';
    global.__n7mTagError = nextMode === 'tag';
    req('./electron/browser-launch.cjs').launch = async () => {
      if (nextMode === 'launch') throw new Error('Synthetic browser launch unavailable');
      if (nextMode === 'scan') global.__n7mSnapshotError = true;
    };
  }, mode);
}
async function expectReady(email, warning = false) {
  const row = rowFor(email);
  await expect(row).not.toHaveClass(/is-opened/);
  await expect(row.locator('.status-pill')).toHaveText('可启动');
  if (warning) await expect(row.locator('.status-stack')).toContainText('未关联窗口');
  else await expect(row.locator('.status-stack')).not.toContainText('未关联窗口');
  await expect(row).not.toContainText('检测受限');
  await expect(row).not.toContainText('窗口待确认');
  await expect(startFor(email)).toBeEnabled();
  await expect(row.getByRole('button', { name: '关闭浏览器', exact: true })).toHaveCount(0);
}
function expectIdle(entry) {
  expect(entry.openedAt).toBe(null); expect(entry.usedAt).toBe(null); expect(entry.status).toBe('available');
  expect(entry.browserWindow == null).toBe(true);
}
async function seedEncryptedState(directory, entries) {
  // Seed only this test's new directory, never the user's configured vault.
  const { normalizeState } = await import(pathToFileURL(path.join(root, 'src', 'model.mjs')).href);
  const store = new VaultStore(directory, normalizeState);
  try { await store.setup(MASTER); store.save(normalizeState({ revision: 1, entries })); }
  finally { store.lock(); }
}

test('old unconfirmed launches migrate to nonblocking warnings and remain usable after restart', async () => {
  test.setTimeout(120000);
  const directory = tempData('window-upgrade-'), timestamp = Date.now() - 1000;
  await seedEncryptedState(directory, [
    { id: 'old-unconfirmed', email: 'unconfirmed@example.com', browser: 'Chrome', profile: 'Profile 1',
      browserTracking: 'unconfirmed', browserWindow: null, openedAt: timestamp, usedAt: timestamp, status: 'used' },
    { id: 'old-timer', email: 'timer-only@example.com', browser: 'Edge', profile: 'Profile 2',
      openedAt: timestamp, usedAt: timestamp, status: 'used' }
  ]);
  await launch(directory); await unlock();
  for (let restart = 0; restart < 2; restart++) {
    const data = await load(), old = data.entries.find(entry => entry.id === 'old-unconfirmed'), timer = data.entries.find(entry => entry.id === 'old-timer');
    expectIdle(old); expect(old.browserTracking).toBe('unmanaged'); expect(old.browserTrackingReason).toBe('legacy');
    expectIdle(timer); expect(timer.browserTracking == null).toBe(true);
    expect(data.openedIds).toEqual([]); expect(data.untrackedIds).toEqual([]); expect(data.canCloseIds).toEqual([]);
    await expectReady(old.email, true); await expectReady(timer.email);
    expect(await app.evaluate(() => global.__n7mFakeWindows())).toEqual([]);
    const result = await page.evaluate(() => window.emailManager.closeEntry('old-unconfirmed'));
    expect(result.ok).toBe(false); expect(result.error).toContain('未关联浏览器窗口');
    expect(await app.evaluate(() => global.__n7mCloseRequests)).toEqual([]);
    if (!restart) { await closeApp(); await launch(directory); await unlock(); }
  }
});

test('historical tags with unverifiable Profile identities lose close authority without closing any OS window', async () => {
  test.setTimeout(120000);
  const directory = tempData('window-strict-upgrade-'), timestamp = Date.now() - 1000;
  const baseRecord = { pid: 900001, processStartedAt: '638900000000000000', executable: 'C:\\N7M-Test-Browsers\\chrome.exe',
    profile: 'Profile+21', token: '12345678-1234-4234-8234-123456789abc' };
  const cases = [
    { id: 'valid', browser: 'Chrome', profile: 'Profile+21', browserWindow: { ...baseRecord, hwnd: '201' } },
    { id: 'missing', browser: 'Chrome', profile: 'Profile+21', browserWindow: { ...baseRecord, hwnd: '202', profile: '' } },
    { id: 'mismatch', browser: 'Chrome', profile: 'Profile 21', browserWindow: { ...baseRecord, hwnd: '203' } },
    { id: 'empty', browser: 'Chrome', profile: '', browserWindow: { ...baseRecord, hwnd: '204' } },
    { id: 'firefox', browser: 'Firefox', profile: 'Work+Mail', browserWindow: { ...baseRecord, hwnd: '205', executable: 'C:\\N7M-Test-Browsers\\firefox.exe', profile: 'Work+Mail' } },
    { id: 'default', browser: '系统默认', profile: 'Profile+21', browserWindow: { ...baseRecord, hwnd: '206' } }
  ];
  const entries = cases.map(value => ({ ...value, email: `${value.id}@strict.example`, status: 'used', usedAt: timestamp, openedAt: timestamp, browserTracking: 'tracked' }));
  const originalWindows = cases.map(value => value.browserWindow);
  await seedEncryptedState(directory, entries);
  fs.writeFileSync(path.join(directory, 'fake-browser-windows.json'), JSON.stringify(originalWindows));
  await launch(directory); await unlock();
  for (let restart = 0; restart < 2; restart++) {
    const current = await load();
    expect(current.openedIds).toEqual(['valid']); expect(current.canCloseIds).toEqual(['valid']);
    const valid = current.entries.find(value => value.id === 'valid');
    expect(valid.browserWindow.hwnd).toBe('201'); expect(valid.browserTracking).toBe('tracked');
    for (const value of cases.slice(1)) {
      const migrated = current.entries.find(item => item.id === value.id);
      expectIdle(migrated); expect(migrated.browserTracking).toBe('unmanaged'); expect(migrated.browserTrackingReason).toBe('identity');
      const closing = await page.evaluate(id => window.emailManager.closeEntry(id), value.id);
      expect(closing.ok).toBe(false); expect(closing.error).toContain('未关联浏览器窗口');
    }
    expect(await app.evaluate(() => global.__n7mFakeWindows())).toEqual(originalWindows);
    expect(await app.evaluate(() => global.__n7mCloseRequests)).toEqual([]);
    if (!restart) { await closeApp(); await launch(directory); await unlock(); }
  }
});

test('limited or failed launches never leave permanent pending status or close unrelated windows', async () => {
  test.setTimeout(120000);
  const directory = tempData('window-unmanaged-');
  await launch(directory); await setup();
  const modes = ['baseline', 'scan', 'tag', 'timeout'];
  const entries = [...modes, 'launch'].map((mode, index) => ({ id: `limited-${mode}`, email: `${mode}@example.com`, browser: 'Chrome', profile: `Profile ${index + 1}` }));
  expect((await page.evaluate(entries => window.emailManager.mutateEmailData({ type: 'import', entries }), entries)).ok).toBe(true);
  for (const mode of modes) {
    await fakeLauncher(mode);
    const result = await page.evaluate(id => window.emailManager.openEntry(id), `limited-${mode}`);
    expect(result.ok).toBe(true); expect(result.message).toContain('未能安全识别窗口');
    const entry = result.data.entries.find(entry => entry.id === `limited-${mode}`);
    expectIdle(entry); expect(entry.browserTracking).toBe('unmanaged'); expect(entry.browserTrackingReason).toBe(mode);
    expect(result.data.openedIds).not.toContain(entry.id); expect(result.data.untrackedIds).not.toContain(entry.id); expect(result.data.canCloseIds).not.toContain(entry.id);
    await expectReady(entry.email, true);
    // A later successful scan must not adopt an existing untagged window.
    await fakeLauncher();
    const windows = await app.evaluate(() => global.__n7mFakeWindows());
    const refreshed = await page.evaluate(() => window.emailManager.refreshBrowserWindows());
    expect(refreshed.ok).toBe(true); expect(refreshed.data.openedIds).toEqual([]); expect(refreshed.data.untrackedIds).toEqual([]);
    const closing = await page.evaluate(id => window.emailManager.closeEntry(id), entry.id);
    expect(closing.ok).toBe(false); expect(closing.error).toContain('未关联浏览器窗口');
    expect(await app.evaluate(() => global.__n7mFakeWindows())).toEqual(windows);
    expect(await app.evaluate(() => global.__n7mCloseRequests)).toEqual([]);
  }
  await fakeLauncher('launch');
  const failed = await page.evaluate(() => window.emailManager.openEntry('limited-launch'));
  expect(failed.ok).toBe(false);
  expectIdle((await load()).entries.find(entry => entry.id === 'limited-launch'));
  await expectReady('launch@example.com');
  const unrelated = await app.evaluate(() => global.__n7mFakeWindows());
  expect(unrelated).toHaveLength(3);
  await closeApp(); await launch(directory); await unlock();
  for (const mode of modes) await expectReady(`${mode}@example.com`, true);
  const restarted = await load();
  expect(restarted.openedIds).toEqual([]); expect(restarted.untrackedIds).toEqual([]);
  // Retrying creates and associates a new exact window, keeping earlier,
  // unassociated browser windows outside the software's close authority.
  await fakeLauncher();
  await startFor('baseline@example.com').click();
  await expect(rowFor('baseline@example.com')).toHaveClass(/is-opened/);
  const tracked = (await load()).entries.find(entry => entry.id === 'limited-baseline');
  expect(tracked.browserTracking).toBe('tracked'); expect(tracked.browserTrackingReason == null).toBe(true);
  expect(unrelated.map(window => window.hwnd)).not.toContain(tracked.browserWindow.hwnd);
  await rowFor('baseline@example.com').getByRole('button', { name: '关闭浏览器', exact: true }).click();
  await expectReady('baseline@example.com');
  expect(await app.evaluate(() => global.__n7mFakeWindows())).toEqual(unrelated);
  expect((await app.evaluate(() => global.__n7mCloseRequests)).map(window => window.hwnd)).toEqual([tracked.browserWindow.hwnd]);
});

test('inspection restrictions protect a tracked window through relocking and recover without guessing ownership', async () => {
  test.setTimeout(120000);
  const directory = tempData('window-protected-');
  await launch(directory); await setup(); await fakeLauncher();
  expect((await page.evaluate(() => window.emailManager.mutateEmailData({ type: 'import', entries: [
    { id: 'protected', email: 'protected@example.com', browser: 'Chrome', profile: 'Profile 1' }
  ] }))).ok).toBe(true);
  const unrelated = await app.evaluate(async ({ app }) => {
    const req = process.getBuiltinModule('module').createRequire(`${app.getAppPath()}/package.json`);
    await req('./electron/browser-launch.cjs').launch({ browser: 'Chrome', profile: 'Profile 99' });
    return global.__n7mFakeWindows()[0];
  });
  const opened = await page.evaluate(() => window.emailManager.openEntry('protected'));
  expect(opened.ok).toBe(true);
  const original = opened.data.entries.find(entry => entry.id === 'protected');
  expect(original.browserWindow.hwnd).not.toBe(unrelated.hwnd);
  await app.evaluate(() => { global.__n7mInspectUnknown = true; });
  await page.evaluate(() => window.emailManager.refreshBrowserWindows());
  for (let relock = 0; relock < 2; relock++) {
    const data = await load(), entry = data.entries.find(entry => entry.id === 'protected');
    expect(data.openedIds).toEqual([]); expect(data.canCloseIds).toEqual([]); expect(data.untrackedIds).toEqual(['protected']);
    expect(entry.browserWindow).toEqual(original.browserWindow); expect(entry.openedAt).toBe(original.openedAt); expect(entry.usedAt).toBe(original.usedAt);
    expect(entry.browserTracking).toBe('tracked'); expect(entry.status).toBe('used');
    await expect(rowFor(entry.email).locator('.status-pill')).toHaveText('检测受限');
    await expect(startFor(entry.email)).toBeDisabled();
    expect((await page.evaluate(() => window.emailManager.openEntry('protected'))).ok).toBe(false);
    expect((await page.evaluate(() => window.emailManager.closeEntry('protected'))).ok).toBe(false);
    expect(await app.evaluate(() => global.__n7mFakeWindows().length)).toBe(2);
    expect(await app.evaluate(() => global.__n7mCloseRequests)).toEqual([]);
    if (!relock) {
      // Lock deliberately reloads the renderer; awaiting its IPC promise from
      // the old execution context races with that navigation in packaged builds.
      await page.getByRole('button', { name: '锁定', exact: true }).click();
      await expect(page.getByRole('button', { name: '解锁', exact: true })).toBeVisible();
      await unlock();
    }
  }
  await app.evaluate(() => { global.__n7mInspectUnknown = false; });
  const recovered = await page.evaluate(() => window.emailManager.refreshBrowserWindows());
  expect(recovered.ok).toBe(true); expect(recovered.data.openedIds).toEqual(['protected']); expect(recovered.data.canCloseIds).toEqual(['protected']);
  expect(recovered.data.entries[0].browserWindow).toEqual(original.browserWindow);
  await expect(rowFor(original.email).locator('.status-pill')).toHaveText('已打开');
  // An inaccessible check must also retain the association after an actual
  // external close; only a conclusive later observation can clear its timer.
  await app.evaluate((_electron, hwnd) => { global.__n7mInspectUnknown = true; global.__n7mExternalClose(hwnd); }, original.browserWindow.hwnd);
  const stillUnknown = await page.evaluate(() => window.emailManager.refreshBrowserWindows());
  expect(stillUnknown.data.untrackedIds).toEqual(['protected']);
  expect(stillUnknown.data.entries[0].browserWindow).toEqual(original.browserWindow);
  await app.evaluate(() => { global.__n7mInspectUnknown = false; });
  const closed = await page.evaluate(() => window.emailManager.refreshBrowserWindows());
  expectIdle(closed.data.entries[0]); expect(closed.data.untrackedIds).toEqual([]); expect(closed.data.openedIds).toEqual([]);
  await expectReady(original.email);
  expect(await app.evaluate(() => global.__n7mFakeWindows())).toEqual([unrelated]);
  expect(await app.evaluate(() => global.__n7mCloseRequests)).toEqual([]);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(window => !window.isVisible()))).toBe(true);
});

test.afterEach(closeApp);
