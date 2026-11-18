'use strict';
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const MASTER = 'N7M-backup-routing-test-password';
const TOTP = 'JBSWY3DPEHPK3PXP';
let application;

test('encrypted restore preview and overwrite distinguish a shared mailbox by browser and Profile, and reject stale route membership', async () => {
  test.setTimeout(150000);
  const results = path.join(root, 'test-results'); fs.mkdirSync(results, { recursive: true });
  const directory = fs.mkdtempSync(path.join(results, 'backup-routing-'));
  const packaged = process.env.N7M_PACKAGED_TEST === '1';
  const packagedDirectory = process.env.N7M_PACKAGED_DIR ? path.resolve(process.env.N7M_PACKAGED_DIR) : path.join(root, 'release', 'win-unpacked');
  const env = { ...process.env, N7M_TEST_DATA_DIR: directory,
    N7M_BACKGROUND_APP_ROOT: packaged ? path.join(packagedDirectory, 'resources', 'app.asar') : root,
    N7M_BACKGROUND_PRODUCTION: packaged ? '1' : '0' };
  delete env.ELECTRON_RUN_AS_NODE;
  // The bootstrap hides every native window and stubs all OS dialogs and
  // browser boundaries before loading the application.
  application = await electron.launch({ args: [path.join(root, 'tests', 'background-electron.cjs')], env, timeout: 30000 });
  const page = await application.firstWindow();
  expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(window => !window.isVisible()))).toBe(true);
  await page.getByLabel('软件密码', { exact: true }).fill(MASTER);
  await page.getByLabel('确认软件密码', { exact: true }).fill(MASTER);
  await page.getByRole('button', { name: '设置密码并解锁', exact: true }).click();
  await expect(page.getByRole('heading', { name: '全部账号', exact: true })).toBeVisible();

  const source = await page.evaluate(secret => window.emailManager.mutateEmailData({ type: 'import', entries: [
    { id: 'source-chrome', email: 'shared-routing@example.com', browser: 'Chrome', profile: 'Profile 1', password: 'backup chrome credential', totpSecret: secret, notes: 'backup chrome business' },
    { id: 'source-firefox', email: 'shared-routing@example.com', browser: 'Firefox', profile: 'Work', password: 'backup firefox credential', totpSecret: 'GEZDGNBVGY3TQOJQ', notes: 'backup firefox business' },
  ] }), TOTP);
  expect(source.ok).toBe(true); expect(source.data.entries).toHaveLength(2);
  const backupPath = path.join(directory, 'shared-routes.n7mbackup');
  await application.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, backupPath);
  const exported = await page.evaluate(master => window.emailManager.exportEncryptedBackup(undefined, master), MASTER);
  expect(exported.ok).toBe(true); expect(fs.existsSync(backupPath)).toBe(true);
  const backup = fs.readFileSync(backupPath), bytes = [...backup];
  for (const secret of ['shared-routing@example.com', 'backup chrome credential', 'backup firefox credential', TOTP]) expect(backup.toString('utf8')).not.toContain(secret);
  expect((await page.evaluate(() => window.emailManager.mutateEmailData({ type: 'delete', ids: ['source-chrome', 'source-firefox'] }))).ok).toBe(true);
  const target = await page.evaluate(() => window.emailManager.mutateEmailData({ type: 'import', entries: [
    { id: 'target-matching', email: 'shared-routing@example.com', browser: 'Chrome', profile: 'Profile 1', password: 'local matching credential', notes: 'local matching business' },
    { id: 'target-third', email: 'shared-routing@example.com', browser: 'Chrome', profile: 'Profile+21', password: 'preserve third credential', totpSecret: 'GEZDGNBVGY3TQOJQ', notes: 'preserve third business' },
  ] }));
  expect(target.ok).toBe(true); expect(target.data.entries).toHaveLength(2);

  const preview = await page.evaluate(({ bytes, master }) => window.emailManager.previewBackup(new Uint8Array(bytes), master), { bytes, master: MASTER });
  expect(preview.ok).toBe(true); expect(preview.total).toBe(2);
  expect(preview.existingCount).toBe(1); expect(preview.newCount).toBe(1); expect(preview.currentCount).toBe(2);
  expect(Object.hasOwn(preview, 'entries')).toBe(false);
  for (const secret of ['backup chrome credential', 'backup firefox credential', TOTP]) expect(JSON.stringify(preview)).not.toContain(secret);
  const restored = await page.evaluate(token => window.emailManager.restoreBackup({ token, policy: 'overwrite', restoreSettings: false }), preview.token);
  expect(restored.ok).toBe(true); expect(restored.counts).toEqual({ added: 1, updated: 1, skipped: 0 });
  expect(restored.data.entries).toHaveLength(3);
  expect(new Set(restored.data.entries.map(entry => entry.id)).size).toBe(3);
  const matching = restored.data.entries.find(entry => entry.id === 'target-matching');
  const third = restored.data.entries.find(entry => entry.id === 'target-third');
  const added = restored.data.entries.find(entry => entry.browser === 'Firefox' && entry.profile === 'Work');
  expect(matching.profile).toBe('Profile 1'); expect(matching.notes).toBe('backup chrome business');
  expect(third.profile).toBe('Profile+21'); expect(third.notes).toBe('preserve third business');
  expect(added).toBeTruthy(); expect(added.id).not.toBe('source-firefox');
  const secrets = await page.evaluate(async ids => Promise.all(ids.map(id => window.emailManager.readEntrySecrets(id))), [matching.id, third.id, added.id]);
  expect(secrets.map(value => value.password)).toEqual(['backup chrome credential', 'preserve third credential', 'backup firefox credential']);
  expect(secrets.map(value => value.totpSecret)).toEqual([TOTP, 'GEZDGNBVGY3TQOJQ', 'GEZDGNBVGY3TQOJQ']);

  const stale = await page.evaluate(({ bytes, master }) => window.emailManager.previewBackup(new Uint8Array(bytes), master), { bytes, master: MASTER });
  expect(stale.ok).toBe(true); expect(stale.existingCount).toBe(2); expect(stale.newCount).toBe(0);
  const changed = await page.evaluate(() => window.emailManager.mutateEmailData({ type: 'update', ids: ['target-matching'], patch: { profile: 'Profile 9', password: 'credential edited after preview' } }));
  expect(changed.ok).toBe(true);
  const rejected = await page.evaluate(token => window.emailManager.restoreBackup({ token, policy: 'overwrite', restoreSettings: false }), stale.token);
  expect(rejected.ok).toBe(false); expect(rejected.error).toMatch(/列表已变化|重新检查/);
  const unchanged = await page.evaluate(() => window.emailManager.loadEmailData());
  expect(unchanged.data.revision).toBe(changed.data.revision); expect(unchanged.data.entries).toHaveLength(3);
  expect(unchanged.data.entries.find(entry => entry.id === 'target-matching').profile).toBe('Profile 9');
  const protectedSecrets = await page.evaluate(async () => Promise.all(['target-matching', 'target-third'].map(id => window.emailManager.readEntrySecrets(id))));
  expect(protectedSecrets.map(value => value.password)).toEqual(['credential edited after preview', 'preserve third credential']);
  expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(window => !window.isVisible()))).toBe(true);
});

test.afterEach(async () => { if (application) { await application.close(); application = null; } });
