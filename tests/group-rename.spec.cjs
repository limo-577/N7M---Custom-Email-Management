'use strict';
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const MASTER = 'N7M-group-rename-test-password';
const SECRET = 'JBSWY3DPEHPK3PXP';
const PASSWORD = '  synthetic rename password  ';
let application, page;

async function launch(directory) {
  const packaged = process.env.N7M_PACKAGED_TEST === '1';
  const packagedDirectory = process.env.N7M_PACKAGED_DIR ? path.resolve(process.env.N7M_PACKAGED_DIR) : path.join(root, 'release', 'win-unpacked');
  const env = { ...process.env, N7M_TEST_DATA_DIR: directory,
    N7M_BACKGROUND_APP_ROOT: packaged ? path.join(packagedDirectory, 'resources', 'app.asar') : root,
    N7M_BACKGROUND_PRODUCTION: packaged ? '1' : '0' };
  delete env.ELECTRON_RUN_AS_NODE;
  // Load the existing invisible fixture before application startup. It replaces
  // real browsers, OS dialogs and the clipboard, and uses this fresh test vault.
  application = await electron.launch({ args: [path.join(root, 'tests', 'background-electron.cjs')], env, timeout: 30000 });
  page = await application.firstWindow();
  await hiddenWindows();
}
async function hiddenWindows() {
  expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(window => !window.isVisible()))).toBe(true);
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
  expect(result.ok, result.error).toBe(true); return result.data;
}
async function mutate(operation) {
  const result = await page.evaluate(operation => window.emailManager.mutateEmailData(operation), operation);
  expect(result.ok, result.error).toBe(true); return result.data;
}
async function groupMenu() {
  const menu = page.getByLabel('分组管理', { exact: true });
  if (!await menu.isVisible()) await page.getByRole('button', { name: '账号分组', exact: true }).click();
  await expect(menu).toBeVisible(); return menu;
}
const renameDialog = () => page.getByRole('dialog', { name: '重命名分组', exact: true });
const groupNav = () => page.locator('.sidebar-nav>button').filter({ hasText: /^分组/ });
const withoutGroup = entries => entries.map(({ group, ...entry }) => entry);
async function renameFrom(container, name) {
  await container.getByRole('button', { name: `重命名分组 ${name}`, exact: true }).click();
  const dialog = renameDialog();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('新分组名称', { exact: true })).toHaveValue(name);
  return dialog;
}
async function saveName(dialog, name) {
  await dialog.getByLabel('新分组名称', { exact: true }).fill(name);
  await dialog.getByRole('button', { name: '保存名称', exact: true }).click();
}
async function expectNames(names) {
  expect((await load()).groups).toEqual(names);
  await expect(groupNav().locator('small')).toHaveText(String(names.length));
}
async function testSecrets() {
  return page.evaluate(async () => Promise.all(['rename-a', 'rename-b'].map(id => window.emailManager.readEntrySecrets(id))));
}

test('group rename is accessible from both group views, preserves account credentials and active windows, and survives relock and restart', async () => {
  test.setTimeout(120000);
  const results = path.join(root, 'test-results'); fs.mkdirSync(results, { recursive: true });
  const directory = fs.mkdtempSync(path.join(results, 'group-rename-'));
  await launch(directory); await setup();
  await mutate({ type: 'import', entries: [
    { id: 'rename-a', displayId: '001', email: 'rename-a@example.com', browser: 'Chrome', profile: 'Profile 1', group: '工作', notes: '业务备注 A', tags: ['常用'], password: PASSWORD, totpSecret: SECRET },
    { id: 'rename-b', displayId: '002', email: 'rename-b@example.com', browser: 'Firefox', profile: 'Work', group: '工作', notes: '业务备注 B', password: 'synthetic other password' },
    { id: 'rename-other', displayId: '003', email: 'rename-other@example.com', browser: 'Edge', profile: 'Default', group: '私人', notes: '其他分组保持原样' },
  ] });
  await mutate({ type: 'group-add', name: '空分组' });
  await expectNames(['工作', '私人', '空分组']);
  const originalSecrets = await testSecrets();
  expect(originalSecrets[0]).toMatchObject({ ok: true, password: PASSWORD, totpSecret: SECRET });
  expect(originalSecrets[1]).toMatchObject({ ok: true, password: 'synthetic other password', totpSecret: '' });
  await application.evaluate(({ app }) => {
    const requireFromApp = process.getBuiltinModule('module').createRequire(`${app.getAppPath()}/package.json`);
    requireFromApp('./electron/browser-launch.cjs').launch = async () => {};
  });
  const opened = await page.evaluate(() => window.emailManager.openEntry('rename-a'));
  expect(opened.ok, opened.error).toBe(true); expect(opened.data.openedIds).toEqual(['rename-a']);
  expect(opened.data.entries.find(entry => entry.id === 'rename-a').browserWindow).toBeTruthy();
  const originalEntries = opened.data.entries;

  await page.getByRole('button', { name: '打开快捷栏', exact: true }).click();
  await expect.poll(() => application.windows().length).toBe(2);
  const toolbar = application.windows().find(window => window !== page);
  const toolbarGroups = toolbar.getByLabel('快捷栏分组筛选', { exact: true });
  await toolbarGroups.selectOption('工作');
  await expect(toolbar.locator('.quick-card')).toHaveCount(2);

  let menu = await groupMenu();
  await menu.getByRole('button', { name: '筛选分组 工作', exact: true }).click();
  await expect(page.locator('.accounts-table tbody tr')).toHaveCount(2);
  menu = await groupMenu();
  await expect(menu.getByRole('button', { name: /^重命名分组 / })).toHaveCount(3);
  await page.screenshot({ path: path.join(results, 'N7M-group-rename-dropdown.png'), fullPage: true });
  let dialog = await renameFrom(menu, '工作');
  await page.screenshot({ path: path.join(results, 'N7M-group-rename-dialog.png'), fullPage: true });
  await saveName(dialog, '  业务一组  ');
  await expect(dialog).toHaveCount(0);
  await expectNames(['业务一组', '私人', '空分组']);
  const renamed = await load();
  expect(withoutGroup(renamed.entries)).toEqual(withoutGroup(originalEntries));
  expect(renamed.entries.map(entry => entry.group)).toEqual(['业务一组', '业务一组', '私人']);
  expect(renamed.openedIds).toEqual(['rename-a']);
  expect(await testSecrets()).toEqual(originalSecrets);
  // The current main filter follows the new group name rather than silently
  // widening to all accounts after the old name disappears from the catalog.
  await expect(page.locator('.accounts-table tbody tr')).toHaveCount(2);
  await expect(page.locator('.filter-chip')).toContainText('业务一组');
  await expect(page.locator('.accounts-table tbody')).not.toContainText('rename-other@example.com');
  await expect(toolbarGroups).toHaveValue('');
  await expect(toolbarGroups.locator('option[value="工作"]')).toHaveCount(0);
  await expect(toolbarGroups.locator('option[value="业务一组"]')).toContainText('2');
  await toolbarGroups.selectOption('业务一组');
  await expect(toolbar.locator('.quick-card')).toHaveCount(2);
  await expect(toolbar.locator('.quick-card').filter({ hasText: 'rename-a@example.com' })).toHaveClass(/is-opened/);

  await groupNav().click();
  const overview = page.getByLabel('全部分组', { exact: true });
  await expect(overview.getByRole('button', { name: /^重命名分组 / })).toHaveCount(3);
  dialog = await renameFrom(overview, '空分组');
  await saveName(dialog, '空分组改名');
  await expect(dialog).toHaveCount(0);
  await expectNames(['业务一组', '私人', '空分组改名']);
  await expect(overview.getByRole('button', { name: '查看分组 空分组改名', exact: true })).toBeVisible();
  await expect(overview.getByRole('button', { name: '查看分组 空分组改名', exact: true })).toContainText('0');
  await expect(overview.getByRole('button', { name: '查看分组 空分组', exact: true })).toHaveCount(0);
  await expect(toolbarGroups).toHaveValue('业务一组');
  await expect(toolbarGroups.locator('option[value="空分组改名"]')).toContainText('0');
  await page.screenshot({ path: path.join(results, 'N7M-group-rename-overview.png'), fullPage: true });

  const beforeRejected = await load();
  dialog = await renameFrom(overview, '业务一组');
  await saveName(dialog, '私人');
  await expect(dialog.getByRole('alert')).toContainText(/已存在|重复/);
  expect(await load()).toEqual(beforeRejected);
  await saveName(dialog, '   ');
  await expect(dialog.getByRole('alert')).toContainText(/名称|分组/);
  expect(await load()).toEqual(beforeRejected);
  await dialog.getByLabel('新分组名称', { exact: true }).fill('不应保存的名称');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(await load()).toEqual(beforeRejected);
  expect(await testSecrets()).toEqual(originalSecrets);

  await page.getByRole('button', { name: '锁定', exact: true }).click();
  await expect(page.getByRole('button', { name: '解锁', exact: true })).toBeVisible();
  await expect.poll(() => application.windows().length).toBe(1);
  await unlock();
  await expectNames(['业务一组', '私人', '空分组改名']);
  expect(withoutGroup((await load()).entries)).toEqual(withoutGroup(originalEntries));
  expect(await testSecrets()).toEqual(originalSecrets);

  const previous = application; application = null; page = null; await previous.close();
  await launch(directory); await unlock();
  await expectNames(['业务一组', '私人', '空分组改名']);
  const restarted = await load();
  expect(restarted.entries.map(entry => entry.group)).toEqual(['业务一组', '业务一组', '私人']);
  expect(withoutGroup(restarted.entries)).toEqual(withoutGroup(originalEntries));
  expect(restarted.openedIds).toEqual(['rename-a']);
  expect(await testSecrets()).toEqual(originalSecrets);
  await hiddenWindows();
});

test.afterEach(async () => { const current = application; application = null; page = null; if (current) await current.close(); });
