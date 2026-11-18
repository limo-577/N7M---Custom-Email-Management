'use strict';
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const MASTER = 'N7M-sensitive-context-test-password';
let application;

test('same-page reload revokes pending bulk authorization and encrypted export before capability creation or file writes', async () => {
  test.setTimeout(120000);
  const results = path.join(root, 'test-results'); fs.mkdirSync(results, { recursive: true });
  const directory = fs.mkdtempSync(path.join(results, 'sensitive-epoch-'));
  const packaged = process.env.N7M_PACKAGED_TEST === '1';
  const packagedDirectory = process.env.N7M_PACKAGED_DIR ? path.resolve(process.env.N7M_PACKAGED_DIR) : path.join(root, 'release', 'win-unpacked');
  const env = { ...process.env, N7M_TEST_DATA_DIR: directory,
    N7M_BACKGROUND_APP_ROOT: packaged ? path.join(packagedDirectory, 'resources', 'app.asar') : root,
    N7M_BACKGROUND_PRODUCTION: packaged ? '1' : '0' };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ args: [path.join(root, 'tests', 'background-electron.cjs')], env, timeout: 30000 });
  const page = await application.firstWindow();
  expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(window => !window.isVisible()))).toBe(true);
  await page.getByLabel('软件密码', { exact: true }).fill(MASTER);
  await page.getByLabel('确认软件密码', { exact: true }).fill(MASTER);
  await page.getByRole('button', { name: '设置密码并解锁', exact: true }).click();
  await expect(page.getByRole('heading', { name: '全部账号', exact: true })).toBeVisible();
  const seeded = await page.evaluate(() => window.emailManager.mutateEmailData({ type: 'import', entries: [
    { id: 'epoch-account', email: 'epoch-fixture@example.com', browser: 'Chrome', password: 'fixture-only-account-password', totpSecret: 'JBSWY3DPEHPK3PXP' }
  ] }));
  expect(seeded.ok).toBe(true);
  await application.evaluate(({ app, dialog }) => {
    const requireFromApp = process.getBuiltinModule('module').createRequire(`${app.getAppPath()}/package.json`);
    const { EditSessions } = requireFromApp('./electron/edit-sessions.cjs');
    const { VaultStore } = requireFromApp('./electron/vault.cjs');
    const originalCreate = EditSessions.prototype.create;
    const originalRead = VaultStore.prototype.getEntriesForEditing;
    global.__n7mEpochCapabilityCreates = 0;
    EditSessions.prototype.create = function(...arguments_) {
      global.__n7mEpochCapabilityCreates++;
      return originalCreate.apply(this, arguments_);
    };
    // Hold the authenticated result deterministically, rather than relying on
    // a reload being faster than this machine's real Argon2 worker.
    VaultStore.prototype.getEntriesForEditing = async function(...arguments_) {
      global.__n7mEpochReadStarted = true;
      const entries = await originalRead.apply(this, arguments_);
      global.__n7mEpochReadAuthenticated = true;
      await new Promise(resolve => { global.__n7mEpochReleaseRead = resolve; });
      global.__n7mEpochReadReleased = true;
      return entries;
    };
    global.__n7mEpochSaveDialogCalls = 0;
    // Never invoke a native dialog. This boundary is an explicitly held fake.
    dialog.showSaveDialog = async () => {
      global.__n7mEpochSaveDialogCalls++;
      const result = await new Promise(resolve => { global.__n7mEpochReleaseDialog = resolve; });
      global.__n7mEpochDialogReturned = true;
      return result;
    };
  });
  const pageUrl = page.url();
  const pendingRead = page.evaluate(password => window.emailManager.beginBulkEdit(password, ['epoch-account']), MASTER).catch(() => null);
  await expect.poll(() => application.evaluate(() => global.__n7mEpochReadStarted === true)).toBe(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: '全部账号', exact: true })).toBeVisible();
  expect(page.url()).toBe(pageUrl);
  await expect.poll(() => application.evaluate(() => global.__n7mEpochReadAuthenticated === true), { timeout: 20000 }).toBe(true);
  await application.evaluate(() => global.__n7mEpochReleaseRead());
  await expect.poll(() => application.evaluate(() => global.__n7mEpochReadReleased === true)).toBe(true);
  await application.evaluate(() => new Promise(resolve => setImmediate(resolve)));
  expect(await application.evaluate(() => global.__n7mEpochCapabilityCreates)).toBe(0);
  await pendingRead;

  const forbiddenOutput = path.join(directory, 'must-not-write-after-reload.n7mbackup');
  const pendingExport = page.evaluate(password => window.emailManager.exportEncryptedBackup(undefined, password), MASTER).catch(() => null);
  await expect.poll(() => application.evaluate(() => global.__n7mEpochSaveDialogCalls), { timeout: 25000 }).toBe(1);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: '全部账号', exact: true })).toBeVisible();
  expect(page.url()).toBe(pageUrl);
  await application.evaluate((_electron, filePath) => global.__n7mEpochReleaseDialog({ canceled: false, filePath }), forbiddenOutput);
  await expect.poll(() => application.evaluate(() => global.__n7mEpochDialogReturned === true)).toBe(true);
  await application.evaluate(() => new Promise(resolve => setImmediate(resolve)));
  expect(fs.existsSync(forbiddenOutput)).toBe(false);
  expect(fs.readdirSync(directory).some(name => name.startsWith('must-not-write-after-reload.n7mbackup'))).toBe(false);
  expect(await application.evaluate(() => global.__n7mEpochSaveDialogCalls)).toBe(1);
  expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(window => !window.isVisible()))).toBe(true);
  await pendingExport;
});

test.afterEach(async () => { if (application) { await application.close(); application = null; } });
