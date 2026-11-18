'use strict';
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const MASTER = 'N7M-sorting-and-toolbar-test-password';
let application, page;

const fixtures = () => [
  { id: 'natural-10', displayId: '101', email: 'user10@example.com', browser: 'Chrome', profile: 'Profile 1', notes: '项目10', group: '工作', tags: ['常用'] },
  { id: 'case-upper', displayId: '102', email: 'Alpha@example.com', browser: 'Edge', profile: 'Default', notes: '备注2', group: '工作' },
  { id: 'natural-2', displayId: '103', email: 'user2@example.com', browser: 'Firefox', profile: 'Work', notes: '项目2', group: '项目', tags: ['常用'] },
  { id: 'case-lower', displayId: '104', email: 'alpha@example.com', browser: 'Brave', profile: 'Profile+21', notes: '备注2', group: '项目' },
  { id: 'chinese-beijing', displayId: '105', email: '北京账号', browser: 'Chrome', profile: 'Profile 2', notes: '北京业务', group: '' },
  { id: 'chinese-shanghai', displayId: '106', email: '上海账号', browser: 'Edge', profile: 'Profile 2', notes: '上海业务', group: '工作' },
  { id: 'blank-notes-a', displayId: '107', email: 'zz-empty-a@example.com', browser: '', notes: '', group: '未完成组' },
  { id: 'blank-notes-b', displayId: '108', email: 'zz-empty-b@example.com', browser: 'Chrome', profile: 'Profile 3', notes: '   ', group: '' },
];
const originalOrder = ['101', '102', '103', '104', '105', '106', '107', '108'];
const emailAscending = ['105', '106', '102', '104', '103', '101', '107', '108'];
const emailDescending = ['108', '107', '101', '103', '102', '104', '106', '105'];
const notesAscending = ['105', '102', '104', '106', '103', '101', '107', '108'];
const notesDescending = ['101', '103', '106', '102', '104', '105', '107', '108'];
const rowIds = () => page.locator('.accounts-table tbody .account-id').allTextContents();
const expectRows = ids => expect.poll(rowIds).toEqual(ids);
const quickIds = toolbar => toolbar.locator('.quick-card-info>strong').allTextContents();
const quickCard = (toolbar, number) => toolbar.locator('.quick-card').filter({ has: toolbar.locator('.quick-card-info>strong').filter({ hasText: new RegExp(`^${number}$`) }) });

async function launch() {
  const results = path.join(root, 'test-results'); fs.mkdirSync(results, { recursive: true });
  const directory = fs.mkdtempSync(path.join(results, 'sorting-toolbar-'));
  const packaged = process.env.N7M_PACKAGED_TEST === '1';
  const packagedDirectory = process.env.N7M_PACKAGED_DIR ? path.resolve(process.env.N7M_PACKAGED_DIR) : path.join(root, 'release', 'win-unpacked');
  const env = { ...process.env, N7M_TEST_DATA_DIR: directory,
    N7M_BACKGROUND_APP_ROOT: packaged ? path.join(packagedDirectory, 'resources', 'app.asar') : root,
    N7M_BACKGROUND_PRODUCTION: packaged ? '1' : '0' };
  delete env.ELECTRON_RUN_AS_NODE;
  // This fixture hides windows and replaces browsers, native dialogs and the
  // clipboard before application startup. All records belong to a fresh vault.
  application = await electron.launch({ args: [path.join(root, 'tests', 'background-electron.cjs')], env, timeout: 30000 });
  page = await application.firstWindow();
  await hiddenWindows();
  await page.getByLabel('软件密码', { exact: true }).fill(MASTER);
  await page.getByLabel('确认软件密码', { exact: true }).fill(MASTER);
  await page.getByRole('button', { name: '设置密码并解锁', exact: true }).click();
  await expect(page.getByRole('heading', { name: '全部账号', exact: true })).toBeVisible();
  await mutate({ type: 'import', entries: fixtures() });
  await mutate({ type: 'group-add', name: '空分组' });
  await expectRows(originalOrder);
  await application.evaluate(({ app }) => {
    const requireFromApp = process.getBuiltinModule('module').createRequire(`${app.getAppPath()}/package.json`);
    global.__n7mSortLaunches = [];
    requireFromApp('./electron/browser-launch.cjs').launch = async entry => {
      // The OS boundary deliberately receives only the launch route. Verify
      // the account ID separately through the main-process openedIds snapshot.
      global.__n7mSortLaunches.push({ browser: entry.browser, profile: entry.profile });
    };
  });
}
async function hiddenWindows() {
  expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(window => !window.isVisible()))).toBe(true);
}
async function mutate(operation) {
  const result = await page.evaluate(operation => window.emailManager.mutateEmailData(operation), operation);
  expect(result.ok, result.error).toBe(true); return result.data;
}
async function filterMainGroup(name) {
  await page.getByRole('button', { name: '账号分组', exact: true }).click();
  await page.getByLabel('分组管理', { exact: true }).getByRole('button', { name: `筛选分组 ${name}`, exact: true }).click();
}
async function toolbarCount(toolbar, visible, total) {
  await expect(toolbar.getByText(`显示 ${visible} / ${total} 个账号`, { exact: true })).toBeVisible();
  await expect(toolbar.locator('.quick-card')).toHaveCount(visible);
}
async function optionCount(select, value, count) {
  const option = select.locator('option').filter({ hasText: value === '' ? /全部分组/ : value === '__none' ? /未分组/ : new RegExp(value) });
  await expect(option).toHaveCount(1);
  await expect(option).toHaveAttribute('value', value);
  await expect(option).toContainText(new RegExp(`(?:^|\\D)${count}(?:\\D|$)`));
}

test('email and notes sorting is natural, stable and reversible without changing filters, record identity or selected launch targets', async () => {
  test.setTimeout(120000); await launch();
  const sort = page.getByLabel('账号排序', { exact: true });
  await expect.poll(() => sort.locator('option').evaluateAll(options => options.map(option => option.value))).toEqual(['original', 'browser-asc', 'browser-desc', 'email-asc', 'email-desc', 'notes-asc', 'notes-desc']);
  await page.getByLabel('选择 102', { exact: true }).check();
  const emailHeading = page.getByRole('button', { name: '按邮箱排序', exact: true });
  const notesHeading = page.getByRole('button', { name: '按备注排序', exact: true });
  const browserHeading = page.getByRole('button', { name: '按浏览器类型排序', exact: true });
  const emailHeader = page.locator('th').filter({ has: emailHeading }), notesHeader = page.locator('th').filter({ has: notesHeading });
  await emailHeading.click(); await expect(sort).toHaveValue('email-asc'); await expectRows(emailAscending);
  await expect(emailHeader).toHaveAttribute('aria-sort', 'ascending'); await expect(notesHeader).toHaveAttribute('aria-sort', 'none');
  await emailHeading.click(); await expect(sort).toHaveValue('email-desc'); await expectRows(emailDescending);
  await expect(emailHeader).toHaveAttribute('aria-sort', 'descending');
  await emailHeading.click(); await expect(sort).toHaveValue('original'); await expectRows(originalOrder);
  await expect(emailHeader).toHaveAttribute('aria-sort', 'none');
  await sort.selectOption('email-desc'); await expectRows(emailDescending);
  await notesHeading.click(); await expect(sort).toHaveValue('notes-asc'); await expectRows(notesAscending);
  await expect(notesHeader).toHaveAttribute('aria-sort', 'ascending'); await expect(emailHeader).toHaveAttribute('aria-sort', 'none');
  await notesHeading.click(); await expect(sort).toHaveValue('notes-desc'); await expectRows(notesDescending);
  await expect(notesHeader).toHaveAttribute('aria-sort', 'descending');
  await notesHeading.click(); await expect(sort).toHaveValue('original'); await expectRows(originalOrder);
  await sort.selectOption('notes-asc'); await expectRows(notesAscending);
  await browserHeading.click(); await expect(sort).toHaveValue('browser-asc');
  await expect(page.locator('th').filter({ has: browserHeading })).toHaveAttribute('aria-sort', 'ascending');
  await expect(emailHeader).toHaveAttribute('aria-sort', 'none'); await expect(notesHeader).toHaveAttribute('aria-sort', 'none');

  await sort.selectOption('notes-asc'); await filterMainGroup('项目'); await expectRows(['104', '103']);
  await page.getByLabel('标签筛选', { exact: true }).selectOption('常用');
  await page.getByLabel('搜索账号', { exact: true }).fill('user2'); await expectRows(['103']);
  await expect(page.locator('.bulk-bar')).toContainText('已选 1 个');
  await page.getByRole('button', { name: '重置筛选', exact: true }).click();
  await expect(sort).toHaveValue('notes-asc'); await expectRows(notesAscending);
  await expect(page.getByLabel('选择 102', { exact: true })).toBeChecked();
  await sort.selectOption('email-desc'); await expectRows(emailDescending);
  const before = await page.evaluate(() => window.emailManager.loadEmailData());
  expect(before.data.entries.map(entry => entry.id)).toEqual(fixtures().map(entry => entry.id));
  await page.screenshot({ path: path.join(root, 'test-results', 'N7M-email-notes-sort.png'), fullPage: true });
  await page.getByRole('button', { name: '批量启动', exact: true }).click();
  await page.getByRole('dialog', { name: '批量启动浏览器', exact: true }).getByRole('button', { name: '确认启动', exact: true }).click();
  await expect.poll(() => application.evaluate(() => global.__n7mSortLaunches)).toEqual([
    { browser: 'Edge', profile: 'Default' },
  ]);
  await expect.poll(async () => (await page.evaluate(() => window.emailManager.loadEmailData())).data.openedIds).toEqual(['case-upper']);
  const after = await page.evaluate(() => window.emailManager.loadEmailData());
  expect(after.data.openedIds).toEqual(['case-upper']);
  expect(after.data.entries.map(entry => entry.id)).toEqual(fixtures().map(entry => entry.id));
  await hiddenWindows();
});

test('toolbar group filtering counts configured accounts independently, updates empty and renamed groups, and launches the displayed record', async () => {
  test.setTimeout(120000); await launch();
  await page.getByRole('button', { name: '打开快捷栏', exact: true }).click();
  await expect.poll(() => application.windows().length).toBe(2);
  const toolbar = application.windows().find(window => window !== page);
  const select = toolbar.getByLabel('快捷栏分组筛选', { exact: true });
  await expect(select).toHaveValue(''); await toolbarCount(toolbar, 7, 7);
  for (const [value, count] of [['', 7], ['__none', 2], ['工作', 3], ['项目', 2], ['未完成组', 0], ['空分组', 0]]) await optionCount(select, value, count);
  await select.selectOption('工作'); await toolbarCount(toolbar, 3, 7);
  await expect.poll(() => quickIds(toolbar)).toEqual(['101', '102', '106']);
  for (const [number, note] of [['101', '项目10'], ['102', '备注2'], ['106', '上海业务']]) await expect(quickCard(toolbar, number).locator('.quick-notes>span')).toHaveText(note);
  await filterMainGroup('项目'); await page.getByLabel('搜索账号', { exact: true }).fill('user2'); await expectRows(['103']);
  await expect(select).toHaveValue('工作'); await toolbarCount(toolbar, 3, 7);
  await page.getByRole('button', { name: '重置筛选', exact: true }).click(); await expectRows(originalOrder);
  await expect(select).toHaveValue('工作'); await toolbarCount(toolbar, 3, 7);
  await select.selectOption('__none'); await toolbarCount(toolbar, 2, 7);
  await expect.poll(() => quickIds(toolbar)).toEqual(['105', '108']);
  await expect(quickCard(toolbar, '105').locator('.quick-notes>span')).toHaveText('北京业务');
  await expect(quickCard(toolbar, '108').locator('.quick-notes>span')).toHaveText('暂无备注');
  await select.selectOption('空分组'); await toolbarCount(toolbar, 0, 7);
  await expect(toolbar.locator('.toolbar-list .empty')).toContainText(/(?:当前|该|此)分组|空分组/);
  await select.selectOption('未完成组'); await toolbarCount(toolbar, 0, 7);
  await select.selectOption('工作'); await mutate({ type: 'group-rename', name: '工作', newName: '业务A' });
  await expect(select).toHaveValue(''); await toolbarCount(toolbar, 7, 7);
  await expect(select.locator('option[value="工作"]')).toHaveCount(0); await optionCount(select, '业务A', 3);
  await select.selectOption('业务A'); await toolbarCount(toolbar, 3, 7);
  await mutate({ type: 'group-delete', name: '业务A' });
  await expect(select).toHaveValue(''); await toolbarCount(toolbar, 7, 7);
  await expect(select.locator('option[value="业务A"]')).toHaveCount(0); await optionCount(select, '__none', 5);
  await select.selectOption('项目'); await toolbarCount(toolbar, 2, 7);
  await mutate({ type: 'delete', ids: ['natural-2'] });
  await expect(select).toHaveValue('项目'); await toolbarCount(toolbar, 1, 6); await optionCount(select, '项目', 1);
  await expect.poll(() => quickIds(toolbar)).toEqual(['104']);
  await mutate({ type: 'update', ids: ['case-lower'], patch: { group: '' } });
  await expect(select).toHaveValue('项目'); await toolbarCount(toolbar, 0, 6); await optionCount(select, '项目', 0);
  await expect(toolbar.locator('.toolbar-list .empty')).toContainText(/(?:当前|该|此)分组|项目/);
  await mutate({ type: 'group-delete', name: '项目' });
  await expect(select).toHaveValue(''); await toolbarCount(toolbar, 6, 6);
  await expect(select.locator('option[value="项目"]')).toHaveCount(0); await optionCount(select, '__none', 6);
  await select.selectOption('空分组'); await toolbarCount(toolbar, 0, 6);
  await mutate({ type: 'group-add', name: '新空组' });
  await expect(select).toHaveValue('空分组'); await toolbarCount(toolbar, 0, 6); await optionCount(select, '新空组', 0);
  await select.selectOption('__none'); await toolbarCount(toolbar, 6, 6);
  await expect(quickCard(toolbar, '104').locator('.quick-notes>span')).toHaveText('备注2');
  await toolbar.screenshot({ path: path.join(root, 'test-results', 'N7M-toolbar-groups.png'), fullPage: true });
  await quickCard(toolbar, '104').getByRole('button', { name: '启动', exact: true }).click();
  await expect.poll(() => application.evaluate(() => global.__n7mSortLaunches)).toEqual([
    { browser: 'Brave', profile: 'Profile+21' },
  ]);
  await expect(quickCard(toolbar, '104')).toHaveClass(/is-opened/);
  await toolbarCount(toolbar, 6, 6);
  const state = await page.evaluate(() => window.emailManager.loadEmailData());
  expect(state.data.openedIds).toEqual(['case-lower']);
  await hiddenWindows();
});

test.afterEach(async () => { const current = application; application = null; page = null; if (current) await current.close(); });
