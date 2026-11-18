const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ExcelJS = require('exceljs-hardened');
const JSZip = require('jszip');
const root = path.resolve(__dirname, '..');
const MASTER = 'N7M-test-pass123!';
const NEXT_MASTER = 'N7M-next-pass456!';
const ACCOUNT_PASSWORD = '  Demo-account-password!  ';
const TOTP_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
let app, page;
const rowFor = email => page.locator('.accounts-table tbody tr').filter({ hasText: email });
async function expectCounts(total, ready, opened, incomplete) {
  const summary = page.getByLabel('账号统计', { exact: true });
  await expect(summary).toBeVisible();
  await expect(summary.locator(':scope > span')).toHaveText([
    new RegExp(`^全部账号\\s*${total}$`), new RegExp(`^可启动\\s*${ready}$`),
    new RegExp(`^已打开\\s*${opened}$`), new RegExp(`^待完善\\s*${incomplete}$`)
  ]);
}
function tempData(prefix) {
  fs.mkdirSync(path.join(root, 'test-results'), { recursive: true });
  return fs.mkdtempSync(path.join(root, 'test-results', prefix));
}
async function launch(dir, production = false) {
  const packaged = process.env.N7M_PACKAGED_TEST === '1';
  const packagedDir = process.env.N7M_PACKAGED_DIR ? path.resolve(process.env.N7M_PACKAGED_DIR) : path.join(root, 'release', 'win-unpacked');
  const env = { ...process.env, N7M_TEST_DATA_DIR: dir,
    N7M_BACKGROUND_APP_ROOT: packaged ? path.join(packagedDir, 'resources', 'app.asar') : root,
    N7M_BACKGROUND_PRODUCTION: production || packaged ? '1' : '0' };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [path.join(root, 'tests', 'background-electron.cjs')], env, timeout: 30000 });
  page = await app.firstWindow();
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(win => !win.isVisible()))).toBe(true);
}
async function setup() {
  await page.getByLabel('软件密码', { exact: true }).fill(MASTER);
  await page.getByLabel('确认软件密码', { exact: true }).fill(MASTER);
  await page.getByRole('button', { name: '设置密码并解锁', exact: true }).click();
  await expect(page.getByRole('heading', { name: '全部账号', exact: true })).toBeVisible();
}
async function unlock(password = MASTER) {
  await page.getByLabel('软件密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '解锁', exact: true }).click();
  await expect(page.getByRole('heading', { name: '全部账号', exact: true })).toBeVisible();
}
async function stubClipboard() {
  await app.evaluate(({ clipboard }) => {
    global.__n7mClipboard = 'preexisting-clipboard';
    clipboard.writeText = value => { global.__n7mClipboard = value; };
    clipboard.readText = () => global.__n7mClipboard;
    clipboard.clear = () => { global.__n7mClipboard = ''; };
  });
}
async function clipboardText() { return app.evaluate(() => global.__n7mClipboard); }
async function groupMenu() {
  const menu = page.getByLabel('分组管理', { exact: true });
  if (!await menu.isVisible()) await page.getByRole('button', { name: '账号分组', exact: true }).click();
  await expect(menu).toBeVisible();
  return menu;
}
function totpAt(now) {
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(now / 30000)));
  const digest = crypto.createHmac('sha1', Buffer.from('12345678901234567890')).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
}

test('one-page account management: secure migration, optional start page, credentials, import, bulk edit and persistence', async () => {
  test.setTimeout(180000);
  const dataDir = tempData('desktop-secure-');
  const legacy = [{ id: 'legacy', email: 'legacy@example.com', browser: 'Chrome', profile: 'Profile 43', displayId: '001', status: 'available', usedAt: null }];
  const oldFile = path.join(dataDir, 'email-data.json');
  fs.writeFileSync(oldFile, JSON.stringify(legacy)); fs.writeFileSync(`${oldFile}.bak`, JSON.stringify(legacy));
  await launch(dataDir);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await expect(page.getByLabel('确认软件密码', { exact: true })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('legacy@example.com');
  expect(fs.readFileSync(oldFile, 'utf8')).toBe(JSON.stringify(legacy));
  await setup();
  await expectCounts(1, 1, 0, 0);
  await expect(rowFor('legacy@example.com')).not.toContainText('待完善');
  await expect(rowFor('legacy@example.com').getByRole('button', { name: '启动', exact: true })).toBeEnabled();
  expect(fs.existsSync(oldFile)).toBe(false); expect(fs.existsSync(`${oldFile}.bak`)).toBe(false);
  const vaultFile = path.join(dataDir, 'email-vault.json');
  expect(fs.existsSync(vaultFile)).toBe(true);
  expect(fs.readFileSync(vaultFile, 'utf8')).not.toContain('legacy@example.com');
  await expect(page.locator('.app-sidebar')).toHaveCount(1); await expect(page.locator('.stats')).toHaveCount(0);
  for (const name of ['账号分组', '冷却设置', '批量启动页设定', '导入资料', '添加账号', '打开快捷栏']) await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
  await expect(page.locator('.accounts-table th').filter({ hasText: '启动网页' })).toHaveCount(0);
  // File import keeps the missing browser blank and allocates the next software ID.
  await page.getByRole('button', { name: '导入资料', exact: true }).click();
  const csv = '邮箱链接,浏览器,Profile,编号,启动网页,备注,分组,标签\na@example.com,,,,,"first, line\nsecond",工作,常用\nA@example.com,,,999,https://example.com,,,\nb@example.com,Edge,,003,,项目邮箱,项目,常用';
  await page.locator('input[type=file]').setInputFiles({ name: 'accounts.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await expect(page.locator('.preview-summary')).toContainText('2 个可导入');
  await expect(page.locator('.preview-summary')).toContainText('1 个重复');
  await page.getByRole('button', { name: '确认导入 2 个', exact: true }).click();
  await expect(rowFor('a@example.com')).toContainText('004');
  await expectCounts(3, 2, 0, 1);
  await expect(rowFor('a@example.com').getByRole('button', { name: '启动', exact: true })).toBeEnabled();
  await rowFor('a@example.com').getByRole('button', { name: '启动', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('浏览器');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // Only one row edit icon. Passwords remain exact; TOTP seed is entered only through editor.
  await expect(rowFor('a@example.com').getByTitle('编辑账号', { exact: true })).toHaveCount(1);
  await rowFor('a@example.com').getByTitle('编辑账号', { exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('编号', { exact: true }).fill('002');
  await dialog.getByLabel('浏览器', { exact: true }).selectOption('系统默认');
  await dialog.getByLabel('冷却小时', { exact: true }).fill('0.5');
  await dialog.getByLabel('账号密码', { exact: true }).fill(ACCOUNT_PASSWORD);
  await dialog.getByLabel('TOTP密钥', { exact: true }).fill(TOTP_SECRET);
  await dialog.getByRole('button', { name: '保存资料', exact: true }).click();
  await expect(rowFor('a@example.com')).not.toContainText('待完善');
  await expectCounts(3, 3, 0, 0);
  await expect(rowFor('a@example.com')).not.toContainText(ACCOUNT_PASSWORD);
  await expect(rowFor('a@example.com')).not.toContainText(TOTP_SECRET);
  const snapshot = await page.evaluate(() => window.emailManager.loadEmailData());
  const account = snapshot.data.entries.find(entry => entry.email === 'a@example.com');
  expect(account.browser).toBe('系统默认'); expect(account.displayId).toBe('002');
  expect(account.launchUrl).toBe(''); expect(account.hasPassword).toBe(true); expect(account.hasTotp).toBe(true);
  expect(Object.hasOwn(account, 'password')).toBe(false); expect(Object.hasOwn(account, 'totpSecret')).toBe(false);
  expect(fs.readFileSync(vaultFile, 'utf8')).not.toContain(ACCOUNT_PASSWORD.trim());
  expect(fs.readFileSync(vaultFile, 'utf8')).not.toContain(TOTP_SECRET);
  // Secure copy buttons copy password / current one-time code without exposing either in row text.
  await stubClipboard();
  await rowFor('a@example.com').getByRole('button', { name: '密码', exact: true }).click();
  expect(await clipboardText()).toBe(ACCOUNT_PASSWORD);
  const before = Date.now();
  await rowFor('a@example.com').getByRole('button', { name: 'TOTP', exact: true }).click();
  const copiedTotp = await clipboardText();
  expect([totpAt(before), totpAt(Date.now())]).toContain(copiedTotp); expect(copiedTotp).toMatch(/^\d{6}$/);
  // Reopening the editor fetches stored credentials rather than blanking them on unrelated saves.
  await rowFor('a@example.com').getByTitle('编辑账号', { exact: true }).click();
  dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('账号密码', { exact: true })).toHaveValue(ACCOUNT_PASSWORD);
  await expect(dialog.getByLabel('TOTP密钥', { exact: true })).toHaveValue(TOTP_SECRET);
  await dialog.getByLabel('备注', { exact: true }).fill('已手动修改备注');
  await dialog.getByRole('button', { name: '保存资料', exact: true }).click();
  // Excel multi-sheet selection preserves formatted IDs and empty optional page columns.
  const workbook = new ExcelJS.Workbook(); workbook.addWorksheet('说明').addRow(['说明']);
  const sheet = workbook.addWorksheet('账号');
  sheet.addRow(['邮箱链接', '浏览器', 'Profile', '编号', '启动网页', '备注']);
  sheet.addRow(['excel@example.com', 'Chrome', '', 4, '', 'Excel导入']); sheet.getCell('D2').numFmt = '000';
  await page.getByRole('button', { name: '导入资料', exact: true }).click();
  await page.locator('input[type=file]').setInputFiles({ name: 'accounts.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(await workbook.xlsx.writeBuffer()) });
  await page.getByLabel('工作表', { exact: true }).selectOption('1');
  await expect(page.locator('.preview-table')).toContainText('004');
  await page.getByRole('button', { name: '确认导入 1 个', exact: true }).click();
  await expect(rowFor('excel@example.com')).toContainText('004');
  await expect(page.locator('.accounts-table tbody tr')).toHaveCount(4);
  await expectCounts(4, 4, 0, 0);
  // A batch update changes selected fields without clobbering credentials or notes.
  await page.getByLabel('全选当前筛选结果', { exact: true }).check();
  await page.getByRole('button', { name: '统一设置', exact: true }).click();
  dialog = page.getByRole('dialog');
  for (const [label, value] of [['分组', '常用邮箱'], ['标签', '工作, 常用']]) {
    await dialog.getByLabel(`修改${label}`, { exact: true }).check(); await dialog.getByLabel(label, { exact: true }).fill(value);
  }
  await dialog.getByRole('button', { name: '保存资料', exact: true }).click();
  await expect(rowFor('legacy@example.com')).toContainText('常用邮箱');
  const savedSecrets = await page.evaluate(id => window.emailManager.readEntrySecrets(id), account.id);
  expect(savedSecrets.password).toBe(ACCOUNT_PASSWORD); expect(savedSecrets.totpSecret).toBe(TOTP_SECRET);
  // The dedicated top control can set or clear startup pages for the same selection.
  await page.getByRole('button', { name: '批量启动页设定', exact: true }).click();
  await page.getByRole('dialog').getByLabel('启动网页', { exact: true }).fill('https://example.org/shared');
  await page.getByRole('button', { name: '保存启动页', exact: true }).click();
  const withPage = await page.evaluate(() => window.emailManager.loadEmailData());
  expect(withPage.data.entries.every(entry => entry.launchUrl === 'https://example.org/shared')).toBe(true);
  await page.getByRole('button', { name: '批量启动页设定', exact: true }).click();
  await page.getByRole('dialog').getByLabel('启动网页', { exact: true }).fill('');
  await page.getByRole('button', { name: '保存启动页', exact: true }).click();
  const withoutPage = await page.evaluate(() => window.emailManager.loadEmailData());
  expect(withoutPage.data.entries.every(entry => entry.launchUrl === '')).toBe(true);
  await page.getByRole('button', { name: '取消选择', exact: true }).click();
  // Global cooldown remains distinct from per-account setting.
  await page.getByRole('button', { name: '冷却设置', exact: true }).click();
  await page.getByLabel('默认冷却小时', { exact: true }).fill('12');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(rowFor('legacy@example.com')).toContainText('12 小时');
  await expect(rowFor('a@example.com')).toContainText('0.5 小时');
  await page.getByLabel('搜索账号', { exact: true }).fill('手动修改');
  await expect(page.locator('.accounts-table tbody tr')).toHaveCount(1);
  // Summary counts remain global even while the account table is filtered.
  await expectCounts(4, 4, 0, 0);
  await page.getByRole('button', { name: '清除搜索', exact: true }).click();
  // Managed closing requires an explicit Chromium Profile; the earlier edit
  // separately covers saving an optional system-default browser selection.
  expect((await page.evaluate(id => window.emailManager.mutateEmailData({ type: 'update', ids: [id], patch: { browser: 'Chrome', profile: 'Profile 2' } }), account.id)).ok).toBe(true);
  // Stub just the browser adapter; production args have dedicated unit coverage.
  await app.evaluate(({ app }) => {
    const requireFromApp = process.getBuiltinModule('module').createRequire(`${app.getAppPath()}/package.json`);
    const launcher = requireFromApp('./electron/browser-launch.cjs');
    global.__n7mLaunches = [];
    launcher.launch = async entry => { global.__n7mLaunches.push({ browser: entry.browser, launchUrl: entry.launchUrl, profile: entry.profile }); };
  });
  await rowFor('a@example.com').getByRole('button', { name: '启动', exact: true }).click();
  await expect(rowFor('a@example.com').locator('.status-pill.opened')).toHaveText('已打开');
  await expectCounts(4, 3, 1, 0);
  expect(await app.evaluate(() => global.__n7mLaunches)).toEqual([{ browser: 'Chrome', launchUrl: '', profile: 'Profile 2' }]);
  // Export excludes credentials and uses custom IDs / current status.
  const exportPath = path.join(dataDir, 'export.csv');
  await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, exportPath);
  await page.getByRole('button', { name: '导出资料', exact: true }).click();
  const exportDialog = page.getByRole('dialog', { name: '导出资料', exact: true });
  await exportDialog.getByRole('radio', { name: /^普通 CSV/ }).check();
  await exportDialog.getByRole('button', { name: '导出 CSV', exact: true }).click();
  await expect(exportDialog).toHaveCount(0);
  await expect.poll(() => fs.existsSync(exportPath)).toBe(true);
  const exported = fs.readFileSync(exportPath, 'utf8');
  expect(exported).toContain('"002","a@example.com"'); expect(exported).toContain('"已使用"');
  expect(exported).not.toContain(ACCOUNT_PASSWORD.trim()); expect(exported).not.toContain(TOTP_SECRET);
  await page.getByRole('button', { name: '打开快捷栏', exact: true }).click();
  await expect.poll(() => app.windows().length).toBe(2);
  const toolbar = app.windows().find(win => win !== page);
  await expect(toolbar.locator('.quick-card')).toHaveCount(4);
  await expect(toolbar.locator('.quick-card').filter({ hasText: 'a@example.com' }).locator('.quick-notes')).toHaveText('已手动修改备注');
  await rowFor('a@example.com').getByRole('button', { name: '关闭浏览器', exact: true }).click();
  await expect(toolbar.locator('.quick-card')).toHaveCount(4);
  await expectCounts(4, 4, 0, 0);
  await expect(rowFor('a@example.com').getByRole('button', { name: '启动', exact: true })).toBeEnabled();
  const fontSize = await page.locator('.accounts-table tbody td').first().evaluate(el => parseFloat(getComputedStyle(el).fontSize));
  expect(fontSize).toBeGreaterThanOrEqual(14);
  if (await page.getByRole('button', { name: '关闭提示', exact: true }).count()) await page.getByRole('button', { name: '关闭提示', exact: true }).click();
  await page.screenshot({ path: path.join(root, 'test-results', 'desktop-current.png'), fullPage: true });
  expect(errors).toEqual([]);
  await app.close(); app = null; await launch(dataDir);
  await expect(page.getByRole('button', { name: '解锁', exact: true })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('a@example.com');
  await unlock();
  await expect(rowFor('a@example.com')).toContainText('已手动修改备注');
  await expect(rowFor('excel@example.com')).toContainText('004');
  await expect(page.locator('.accounts-table tbody tr')).toHaveCount(4);
});

test('Profile shortcuts, stable browser sorting, dropdown group management and explicit clear-all control', async () => {
  test.setTimeout(120000);
  const dir = tempData('desktop-controls-'); await launch(dir); await setup(); await stubClipboard();
  // Copy browser-internal pages without trying to launch them through the OS.
  const profileHelp = page.getByLabel('浏览器 Profile 查看方法', { exact: true });
  expect(await profileHelp.evaluate(element => element.open)).toBe(false);
  await profileHelp.locator('summary').click();
  for (const [browser, address] of [['Chrome', 'chrome://version'], ['Edge', 'edge://version'], ['Brave', 'brave://version'], ['Firefox', 'about:profiles']]) {
    await page.getByRole('button', { name: `${browser} · ${address}`, exact: true }).click();
    expect(await clipboardText()).toBe(address);
  }
  await profileHelp.locator('summary').click();
  const seeded = [
    { id: 'sort-c1', email: 'chrome-first@example.com', browser: 'Chrome', displayId: '001', group: '原分组', password: ACCOUNT_PASSWORD, totpSecret: TOTP_SECRET },
    { id: 'sort-e1', email: 'edge@example.com', browser: 'Edge', displayId: '002' },
    { id: 'sort-c2', email: 'chrome-second@example.com', browser: 'Chrome', displayId: '003' },
    { id: 'sort-b1', email: 'brave@example.com', browser: 'Brave', displayId: '004' },
    { id: 'sort-s1', email: 'default@example.com', browser: '系统默认', displayId: '005' },
    { id: 'sort-empty', email: 'missing-browser@example.com', browser: '', displayId: '006' }
  ];
  const imported = await page.evaluate(entries => window.emailManager.mutateEmailData({ type: 'import', entries }), seeded);
  expect(imported.ok).toBe(true);
  await expect(page.locator('.accounts-table tbody tr')).toHaveCount(6);
  const rowEmails = async () => page.locator('.accounts-table tbody .email-text').allTextContents();
  const browserOf = Object.fromEntries(seeded.map(entry => [entry.email, entry.browser]));
  const groupOrder = emails => emails.map(email => browserOf[email]).filter(Boolean).filter((browser, index, browsers) => index === 0 || browsers[index - 1] !== browser);
  await expect(page.getByLabel('账号排序', { exact: true })).toHaveValue('original');
  expect(await rowEmails()).toEqual(seeded.map(entry => entry.email));
  await page.getByLabel('账号排序', { exact: true }).selectOption('browser-asc');
  const ascending = await rowEmails();
  expect(ascending).toEqual(['brave@example.com', 'chrome-first@example.com', 'chrome-second@example.com', 'edge@example.com', 'default@example.com', 'missing-browser@example.com']);
  expect(ascending.at(-1)).toBe('missing-browser@example.com');
  expect(ascending.indexOf('chrome-second@example.com')).toBe(ascending.indexOf('chrome-first@example.com') + 1);
  expect(groupOrder(ascending)).toHaveLength(4);
  await page.getByLabel('账号排序', { exact: true }).selectOption('browser-desc');
  const descending = await rowEmails();
  expect(descending).toEqual(['default@example.com', 'edge@example.com', 'chrome-first@example.com', 'chrome-second@example.com', 'brave@example.com', 'missing-browser@example.com']);
  expect(descending.at(-1)).toBe('missing-browser@example.com');
  expect(descending.indexOf('chrome-second@example.com')).toBe(descending.indexOf('chrome-first@example.com') + 1);
  expect(groupOrder(descending)).toEqual(groupOrder(ascending).reverse());
  await page.getByLabel('账号排序', { exact: true }).selectOption('original');
  await page.getByRole('button', { name: '按浏览器类型排序', exact: true }).click();
  await expect(page.getByLabel('账号排序', { exact: true })).toHaveValue('browser-asc');
  await page.getByRole('button', { name: '按浏览器类型排序', exact: true }).click();
  await expect(page.getByLabel('账号排序', { exact: true })).toHaveValue('browser-desc');
  await page.getByRole('button', { name: '按浏览器类型排序', exact: true }).click();
  await expect(page.getByLabel('账号排序', { exact: true })).toHaveValue('original');
  expect(await rowEmails()).toEqual(seeded.map(entry => entry.email));
  // A persistent empty group can be added directly from the dropdown.
  let menu = await groupMenu();
  await expect(menu).toBeVisible(); await expect(page.locator('.modal-shade')).toHaveCount(0);
  const menuFitsWindow = await menu.evaluate(el => { const bounds = el.getBoundingClientRect(); return bounds.left >= 0 && bounds.top >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight; });
  expect(menuFitsWindow).toBe(true);
  await menu.getByLabel('新分组名称', { exact: true }).fill('待处理');
  await menu.getByRole('button', { name: '添加分组', exact: true }).click();
  await expect(menu.getByRole('button', { name: '筛选分组 待处理', exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(root, 'test-results', 'desktop-groups.png'), fullPage: true });
  // The dropdown must remain reachable when the top controls wrap in a narrower window.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1000, 680));
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(1000);
  const narrowMenuFits = await menu.evaluate(el => { const bounds = el.getBoundingClientRect(); return bounds.left >= 0 && bounds.top >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight; });
  expect(narrowMenuFits).toBe(true);
  await expect(page.locator('.security-controls').getByRole('button', { name: '清空全部账号', exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(root, 'test-results', 'desktop-narrow.png'), fullPage: true });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1500, 900));
  let snapshot = await page.evaluate(() => window.emailManager.loadEmailData());
  expect(snapshot.data.groups).toContain('待处理');
  await page.locator('.app-header h1').click();
  await page.getByLabel('选择 001', { exact: true }).check();
  await page.getByLabel('选择 003', { exact: true }).check();
  menu = await groupMenu();
  await menu.getByRole('button', { name: '将已选账号移入 待处理', exact: true }).click();
  snapshot = await page.evaluate(() => window.emailManager.loadEmailData());
  expect(snapshot.data.entries.filter(entry => entry.group === '待处理').map(entry => entry.id)).toEqual(['sort-c1', 'sort-c2']);
  let secrets = await page.evaluate(() => window.emailManager.readEntrySecrets('sort-c1'));
  expect(secrets.password).toBe(ACCOUNT_PASSWORD); expect(secrets.totpSecret).toBe(TOTP_SECRET);
  await page.getByRole('button', { name: '取消选择', exact: true }).click();
  menu = await groupMenu();
  await menu.getByRole('button', { name: '筛选分组 待处理', exact: true }).click();
  await expect(page.locator('.accounts-table tbody tr')).toHaveCount(2);
  // Deleting a group removes membership, never its accounts or credentials.
  menu = await groupMenu();
  await menu.getByRole('button', { name: '删除分组 待处理', exact: true }).click();
  const deletion = page.getByRole('dialog', { name: '删除分组', exact: true });
  await expect(deletion).toContainText('未分组');
  await deletion.getByRole('button', { name: '确认删除分组', exact: true }).click();
  await expect(page.locator('.accounts-table tbody tr')).toHaveCount(6);
  snapshot = await page.evaluate(() => window.emailManager.loadEmailData());
  expect(snapshot.data.entries).toHaveLength(6); expect(snapshot.data.groups).not.toContain('待处理');
  expect(snapshot.data.entries.filter(entry => ['sort-c1', 'sort-c2'].includes(entry.id)).every(entry => entry.group === '')).toBe(true);
  secrets = await page.evaluate(() => window.emailManager.readEntrySecrets('sort-c1'));
  expect(secrets.password).toBe(ACCOUNT_PASSWORD); expect(secrets.totpSecret).toBe(TOTP_SECRET);
  menu = await groupMenu();
  await menu.getByLabel('新分组名称', { exact: true }).fill('持久空分组');
  await menu.getByRole('button', { name: '添加分组', exact: true }).click();
  await expect(menu.getByRole('button', { name: '筛选分组 持久空分组', exact: true })).toBeVisible();
  await page.locator('.app-header h1').click();
  // Clear-all is explicit text at the infrequently used security controls, not search.
  const clearAll = page.locator('.security-controls').getByRole('button', { name: '清空全部账号', exact: true });
  await expect(clearAll).toBeVisible();
  await expect(page.locator('.filters').getByRole('button', { name: '清空全部账号', exact: true })).toHaveCount(0);
  const securityButtons = (await page.locator('.security-controls button').allTextContents()).map(text => text.trim());
  expect(securityButtons.indexOf('清空全部账号')).toBeLessThan(securityButtons.indexOf('修改软件密码'));
  await page.getByLabel('搜索账号', { exact: true }).fill('chrome-first');
  await expect(page.locator('.accounts-table tbody tr')).toHaveCount(1);
  await clearAll.click();
  const clearing = page.getByRole('dialog', { name: '清空全部账号', exact: true });
  await expect(clearing).toContainText('6');
  await expect(clearing.getByRole('button', { name: '确认清空全部', exact: true })).toBeVisible();
  await clearing.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '清除搜索', exact: true }).click();
  await expect(page.locator('.accounts-table tbody tr')).toHaveCount(6);
  await app.close(); app = null; await launch(dir); await unlock();
  menu = await groupMenu();
  await expect(menu.getByRole('button', { name: '筛选分组 持久空分组', exact: true })).toBeVisible();
  snapshot = await page.evaluate(() => window.emailManager.loadEmailData());
  expect(snapshot.data.groups).not.toContain('待处理'); expect(snapshot.data.entries).toHaveLength(6);
});

test('manual/system locks revoke access, purge editor and copied secrets, and password changes survive restart', async () => {
  test.setTimeout(120000);
  const dir = tempData('desktop-lock-'); await launch(dir); await setup(); await stubClipboard();
  const added = await page.evaluate(({ password, secret }) => window.emailManager.mutateEmailData({ type: 'import', entries: [{ id: 'secret-account', email: 'locked@example.com', browser: 'Chrome', displayId: '001', password, totpSecret: secret }] }), { password: ACCOUNT_PASSWORD, secret: TOTP_SECRET });
  expect(added.ok).toBe(true);
  await expect(rowFor('locked@example.com')).toBeVisible();
  await rowFor('locked@example.com').getByRole('button', { name: '密码', exact: true }).click();
  expect(await clipboardText()).toBe(ACCOUNT_PASSWORD);
  await page.getByRole('button', { name: '锁定', exact: true }).click();
  await expect(page.getByRole('button', { name: '解锁', exact: true })).toBeVisible();
  expect(await clipboardText()).toBe('');
  await expect(page.locator('body')).not.toContainText('locked@example.com');
  const blocked = await page.evaluate(async () => Promise.all([
    window.emailManager.loadEmailData(), window.emailManager.readEntrySecrets('secret-account'),
    window.emailManager.copyCredential('secret-account', 'password'), window.emailManager.openEntry('secret-account'),
    window.emailManager.mutateEmailData({ type: 'delete', ids: ['secret-account'] }), window.emailManager.exportEmailData(),
    window.emailManager.importExcelFile('locked-import', new Uint8Array([80, 75])),
    window.emailManager.closeEntry('secret-account'), window.emailManager.refreshBrowserWindows(),
    window.emailManager.beginBulkEdit('N7M-test-pass123!', ['secret-account']),
    window.emailManager.applyBulkEdit({ token: 'locked-session', patches: [{ id: 'secret-account', patch: { password: 'blocked' } }] }),
    window.emailManager.exportEncryptedBackup(undefined, 'N7M-test-pass123!'),
    window.emailManager.previewBackup(new Uint8Array([1, 2]), 'N7M-test-pass123!'),
    window.emailManager.restoreBackup({ token: 'locked-preview', policy: 'fill', restoreSettings: false })
  ]));
  for (const result of blocked) expect(result.ok).toBe(false);
  await page.getByLabel('软件密码', { exact: true }).fill('wrong-password');
  await page.getByRole('button', { name: '解锁', exact: true }).click();
  await expect(page.getByRole('button', { name: '解锁', exact: true })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('locked@example.com');
  await page.waitForTimeout(2500);
  await unlock();
  // Lock-screen while credentials are being edited removes form DOM and closes toolbar.
  await page.getByRole('button', { name: '打开快捷栏', exact: true }).click();
  await expect.poll(() => app.windows().length).toBe(2);
  await rowFor('locked@example.com').getByTitle('编辑账号', { exact: true }).click();
  await expect(page.getByRole('dialog').getByLabel('账号密码', { exact: true })).toHaveValue(ACCOUNT_PASSWORD);
  await app.evaluate(({ powerMonitor }) => powerMonitor.emit('lock-screen'));
  await expect(page.getByRole('button', { name: '解锁', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('input[aria-label="账号密码"]')).toHaveCount(0);
  await expect.poll(() => app.windows().length).toBe(1);
  await unlock();
  // Change the software password, then confirm the old password cannot unlock.
  await page.getByRole('button', { name: '修改软件密码', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('当前软件密码', { exact: true }).fill(MASTER);
  await dialog.getByLabel('新软件密码', { exact: true }).fill(NEXT_MASTER);
  await dialog.getByLabel('确认新密码', { exact: true }).fill(NEXT_MASTER);
  await dialog.getByRole('button', { name: /保存|修改密码/ }).click();
  await expect(dialog).toHaveCount(0);
  await app.close(); app = null; await launch(dir);
  await page.getByLabel('软件密码', { exact: true }).fill(MASTER);
  await page.getByRole('button', { name: '解锁', exact: true }).click();
  await expect(page.locator('body')).not.toContainText('locked@example.com');
  await page.waitForTimeout(2500);
  await unlock(NEXT_MASTER);
  await expect(rowFor('locked@example.com')).toBeVisible();
  const restored = await page.evaluate(() => window.emailManager.readEntrySecrets('secret-account'));
  expect(restored.password).toBe(ACCOUNT_PASSWORD); expect(restored.totpSecret).toBe(TOTP_SECRET);
});

test('corrupt legacy data is preserved when initial encryption cannot migrate it', async () => {
  const dir = tempData('desktop-corrupt-'), file = path.join(dir, 'email-data.json');
  fs.writeFileSync(file, '{broken'); await launch(dir);
  await page.getByLabel('软件密码', { exact: true }).fill(MASTER);
  await page.getByLabel('确认软件密码', { exact: true }).fill(MASTER);
  await page.getByRole('button', { name: '设置密码并解锁', exact: true }).click();
  await expect(page.getByRole('heading', { name: '账号管理', exact: true })).toHaveCount(0);
  expect(fs.readFileSync(file, 'utf8')).toBe('{broken');
  expect(fs.existsSync(path.join(dir, 'email-vault.json'))).toBe(false);
});

test('production CSP blocks inline execution and network access while isolated Excel imports and toolbar still work', async () => {
  const dir = tempData('desktop-production-');
  await launch(dir, true); await setup();
  await expect(page.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveCount(1);
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('Accounts').addRows([['邮箱链接', '浏览器'], ['csp@example.com', 'Chrome']]);
  const file = path.join(dir, 'accounts.xlsx'); await workbook.xlsx.writeFile(file);
  await page.getByRole('button', { name: '导入资料', exact: true }).click();
  await page.locator('input[type=file]').setInputFiles(file);
  await expect(page.getByRole('button', { name: '确认导入 1 个' })).toBeEnabled();
  await page.getByRole('button', { name: '确认导入 1 个' }).click();
  await expect(rowFor('csp@example.com')).toBeVisible();
  const result = await page.evaluate(async () => {
    const script = document.createElement('script'); script.textContent = 'window.__inlineExecuted = true';
    document.head.append(script);
    let networkBlocked = false;
    try { await fetch('https://example.com/'); } catch { networkBlocked = true; }
    return { inlineExecuted: !!window.__inlineExecuted, networkBlocked };
  });
  expect(result).toEqual({ inlineExecuted: false, networkBlocked: true });
  await page.getByRole('button', { name: '打开快捷栏', exact: true }).click();
  await expect.poll(() => app.windows().length).toBe(2);
  const toolbar = app.windows().find(win => win !== page);
  expect((await toolbar.evaluate(() => window.emailManager.getVaultStatus())).ok).toBe(true);
});

test('isolated Excel import rejects compressed expansion, allows cancellation and recovers without saving partial accounts', async () => {
  const dir = tempData('desktop-import-limits-'); await launch(dir, true); await setup();
  const zip = new JSZip(); zip.file('xl/worksheets/sheet1.xml', 'A'.repeat(17 * 1024 * 1024));
  const bomb = Buffer.from(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  expect(bomb.length).toBeLessThan(20 * 1024 * 1024);
  await page.getByRole('button', { name: '导入资料', exact: true }).click();
  await page.locator('input[type=file]').setInputFiles({ name: 'oversized.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: bomb });
  await expect(page.getByRole('dialog').locator('.error-text')).toContainText(/解压|限制|过大/);
  await expect(page.getByRole('button', { name: /^确认导入/ })).toBeDisabled();
  expect((await page.evaluate(() => window.emailManager.loadEmailData())).data.entries).toHaveLength(0);
  await page.locator('input[type=file]').setInputFiles({ name: 'broken.xlsx', mimeType: 'application/octet-stream', buffer: Buffer.from('invalid workbook') });
  await expect(page.getByRole('dialog').locator('.error-text')).toContainText(/无效|损坏|格式|读取失败/);
  // Cancelling while the file is in flight must not restore an old preview.
  await page.locator('input[type=file]').setInputFiles({ name: 'cancel.xlsx', mimeType: 'application/octet-stream', buffer: bomb });
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '导入资料', exact: true }).click();
  const workbook = new ExcelJS.Workbook(); workbook.addWorksheet('Accounts').addRows([['邮箱链接', '浏览器'], ['safe-after-limit@example.com', 'Chrome']]);
  await page.locator('input[type=file]').setInputFiles({ name: 'valid.xlsx', mimeType: 'application/octet-stream', buffer: Buffer.from(await workbook.xlsx.writeBuffer()) });
  await expect(page.getByRole('button', { name: '确认导入 1 个', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '确认导入 1 个', exact: true }).click();
  await expect(rowFor('safe-after-limit@example.com')).toBeVisible();
});

test('three workspaces preserve opened records independently of cooldown, locks and restart; old blank IDs migrate once', async () => {
  test.setTimeout(120000);
  const dir = tempData('desktop-opened-');
  fs.writeFileSync(path.join(dir, 'email-data.json'), JSON.stringify([
    { id: 'opened-a', email: 'open-a@example.com', browser: 'Chrome', profile: 'Profile 1', displayId: '', group: '工作' },
    { id: 'opened-b', email: 'open-b@example.com', browser: 'Edge', displayId: '', group: '' },
    { id: 'old-id', email: 'old@example.com', browser: '', displayId: '007', group: '工作' },
  ]));
  await launch(dir); await setup();
  let result = await page.evaluate(() => window.emailManager.loadEmailData());
  expect(result.data.entries.map(entry => entry.displayId)).toEqual(['008', '009', '007']);
  expect(result.data.openedIds).toEqual([]);
  await expect(page.getByRole('navigation', { name: '主导航', exact: true }).getByRole('button')).toHaveCount(3);
  await expectCounts(3, 2, 0, 1);
  // A rejected launch must never acquire an opened marker or start a cooldown.
  const failed = await page.evaluate(() => window.emailManager.openEntry('opened-b'));
  expect(failed.ok).toBe(false);
  result = await page.evaluate(() => window.emailManager.loadEmailData());
  expect(result.data.openedIds).toEqual([]);
  expect(result.data.entries.find(entry => entry.id === 'opened-b').usedAt).toBe(null);
  await app.evaluate(({ app }) => {
    const req = process.getBuiltinModule('module').createRequire(`${app.getAppPath()}/package.json`);
    req('./electron/browser-launch.cjs').launch = async () => {};
  });
  await rowFor('open-a@example.com').getByRole('button', { name: '启动', exact: true }).click();
  await expect(rowFor('open-a@example.com')).toHaveClass(/is-opened/);
  await expect(rowFor('open-a@example.com').locator('.status-pill.opened')).toHaveText('已打开');
  await expectCounts(3, 1, 1, 1);
  const openedTime = (await page.evaluate(() => window.emailManager.loadEmailData())).data.entries[0].openedAt;
  expect(openedTime).toBeGreaterThan(0);
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: /^已打开/ }).click();
  await expect(page.locator('.accounts-table tbody tr')).toHaveCount(1);
  await expectCounts(3, 1, 1, 1);
  // Cooldown expiry and a reset retain the verified live window and do not permit duplicate starts.
  await page.evaluate(() => window.emailManager.mutateEmailData({ type: 'update', ids: ['opened-a'], patch: { cooldownHours: 0.00000001 } }));
  await expectCounts(3, 1, 1, 1);
  await page.evaluate(() => window.emailManager.mutateEmailData({ type: 'reset', ids: ['opened-a'] }));
  await expect(rowFor('open-a@example.com')).toHaveClass(/is-opened/);
  await expect(rowFor('open-a@example.com').getByRole('button', { name: '启动', exact: true })).toBeDisabled();
  await page.evaluate(() => window.emailManager.mutateEmailData({ type: 'group-add', name: '空分组' }));
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: /^分组/ }).click();
  const overview = page.getByLabel('全部分组', { exact: true });
  await expect(overview.getByRole('button', { name: '查看分组 空分组', exact: true })).toBeVisible();
  await expect(overview.getByRole('button', { name: '查看分组 工作', exact: true })).toBeVisible();
  await overview.getByRole('button', { name: '查看分组 空分组', exact: true }).click();
  await expect(page.locator('.accounts-table tbody tr')).toHaveCount(0);
  await overview.getByRole('button', { name: '查看分组 工作', exact: true }).click();
  await expect(page.locator('.accounts-table tbody tr')).toHaveCount(2);
  await page.getByRole('button', { name: '锁定', exact: true }).click();
  expect((await page.evaluate(() => window.emailManager.closeEntry('opened-a'))).ok).toBe(false);
  await unlock(); await expect(rowFor('open-a@example.com')).toHaveClass(/is-opened/);
  const vaultBytes = fs.readFileSync(path.join(dir, 'email-vault.json'), 'utf8');
  await app.close(); app = null; await launch(dir); await unlock();
  expect(fs.readFileSync(path.join(dir, 'email-vault.json'), 'utf8')).toBe(vaultBytes);
  await expect(rowFor('open-a@example.com')).toHaveClass(/is-opened/);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
  await page.screenshot({ path: path.join(root, 'test-results', 'N7M-1.5.0-all.png'), fullPage: true });
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: /^分组/ }).click();
  await page.screenshot({ path: path.join(root, 'test-results', 'N7M-1.5.0-groups.png'), fullPage: true });
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: /^已打开/ }).click();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 800));
  await page.screenshot({ path: path.join(root, 'test-results', 'N7M-1.5.0-opened.png'), fullPage: true });
  // Closing the corresponding live window clears its marker and timer together.
  await page.evaluate(() => window.emailManager.mutateEmailData({ type: 'update', ids: ['opened-a'], patch: { cooldownHours: 24 } }));
  await rowFor('open-a@example.com').getByRole('button', { name: '关闭浏览器', exact: true }).click();
  await expect(page.locator('.accounts-table tbody tr')).toHaveCount(0);
  result = await page.evaluate(() => window.emailManager.loadEmailData());
  expect(result.data.openedIds).toEqual([]);
  expect(result.data.entries[0].usedAt).toBe(null);
  expect(result.data.entries[0].openedAt).toBe(null);
  expect(result.data.entries[0].status).toBe('available');
  expect((await page.evaluate(() => window.emailManager.closeEntry('missing-account'))).ok).toBe(false);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(win => !win.isVisible()))).toBe(true);
});

test('in-app table accepts rectangular paste, validates atomically, encrypts secrets and allocates sequential IDs', async () => {
  test.setTimeout(120000);
  const dir = tempData('desktop-grid-'); await launch(dir); await setup(); await stubClipboard();
  await page.evaluate(() => window.emailManager.mutateEmailData({ type: 'import', entries: [{ email: 'existing@example.com', browser: 'Chrome' }] }));
  await page.getByRole('button', { name: '批量录入', exact: true }).click();
  const grid = page.getByRole('dialog', { name: '批量录入账号', exact: true });
  const gridProfileHelp = grid.getByLabel('浏览器 Profile 查看方法', { exact: true });
  expect(await gridProfileHelp.evaluate(element => element.open)).toBe(false);
  await gridProfileHelp.locator('summary').click();
  await gridProfileHelp.getByRole('button', { name: 'Chrome · chrome://version', exact: true }).click();
  expect(await clipboardText()).toBe('chrome://version');
  await gridProfileHelp.locator('summary').click();
  await expect(grid.locator('tbody tr')).toHaveCount(8);
  await grid.getByRole('button', { name: '增加 5 行', exact: true }).click();
  await expect(grid.locator('tbody tr')).toHaveCount(13);
  await grid.getByRole('button', { name: '删除第 13 行', exact: true }).click();
  await expect(grid.locator('tbody tr')).toHaveCount(12);
  const matrix = [
    ['grid-a@example.com', 'Chrome', 'Profile 1', '批量备注', '工作', ACCOUNT_PASSWORD, TOTP_SECRET],
    ['grid-b@example.com', 'Edge', 'C:\\bad\\profile', '', '项目', '', ''],
    ['EXISTING@example.com', 'Chrome', '', '', '', 'duplicate-password', ''],
    ['grid-missing@example.com', '', '', '', '', '', ''],
  ].map(row => row.join('\t')).join('\r\n');
  await grid.getByLabel('第 1 行 邮箱资料', { exact: true }).evaluate((input, text) => {
    const data = new DataTransfer(); data.setData('text/plain', text);
    input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  }, matrix);
  await expect(grid.getByLabel('第 2 行 浏览器', { exact: true })).toHaveValue('Edge');
  await expect(grid.getByLabel('第 1 行 密码', { exact: true })).toHaveAttribute('type', 'password');
  await expect(grid.getByLabel('第 1 行 TOTP 密钥', { exact: true })).toHaveAttribute('type', 'password');
  await grid.getByRole('button', { name: /^保存 \d+ 个账号$/ }).click();
  await expect(grid.getByRole('alert')).toContainText('Profile');
  expect((await page.evaluate(() => window.emailManager.loadEmailData())).data.entries).toHaveLength(1);
  await grid.getByLabel('第 2 行 Profile', { exact: true }).fill('Default');
  const exactPassword = '  exact\tpassword\nwith spacing  ';
  await grid.getByLabel('第 1 行 密码', { exact: true }).evaluate((input, value) => {
    input.setSelectionRange(0, input.value.length);
    const data = new DataTransfer(); data.setData('text/plain', value);
    input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  }, exactPassword);
  await expect(grid.locator('.batch-entry-counts')).toContainText('重复跳过 1 个');
  await expect(grid.locator('.batch-entry-counts')).toContainText('已填写 4 行');
  await page.screenshot({ path: path.join(root, 'test-results', 'N7M-1.5.0-grid.png'), fullPage: true });
  await grid.getByRole('button', { name: '保存 3 个账号', exact: true }).click();
  await expect(grid).toHaveCount(0);
  const state = (await page.evaluate(() => window.emailManager.loadEmailData())).data;
  expect(state.entries.map(entry => entry.displayId)).toEqual(['001', '002', '003', '004']);
  expect(state.entries[3].browser).toBe('');
  const first = state.entries.find(entry => entry.email === 'grid-a@example.com');
  expect(first.launchUrl).toBe(''); expect(first.group).toBe('工作'); expect(first.hasPassword).toBe(true); expect(first.hasTotp).toBe(true);
  expect(state.groups).toEqual(['工作', '项目']);
  const secrets = await page.evaluate(id => window.emailManager.readEntrySecrets(id), first.id);
  expect(secrets.password).toBe(exactPassword); expect(secrets.totpSecret).toBe(TOTP_SECRET);
  const encrypted = fs.readFileSync(path.join(dir, 'email-vault.json'), 'utf8');
  for (const secret of ['grid-a@example.com', 'exact', TOTP_SECRET, '批量备注']) expect(encrypted).not.toContain(secret);
  await expect(page.locator('.accounts-panel')).not.toContainText('password');
  await expectCounts(4, 3, 0, 1);
  // Locking with an unfinished grid discards all editable credentials.
  await page.getByRole('button', { name: '批量录入', exact: true }).click();
  await page.getByLabel('第 1 行 密码', { exact: true }).fill('unsaved-private-password');
  await app.evaluate(({ powerMonitor }) => powerMonitor.emit('lock-screen'));
  await expect(page.getByRole('button', { name: '解锁', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await unlock();
  expect((await page.evaluate(() => window.emailManager.loadEmailData())).data.entries).toHaveLength(4);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(win => !win.isVisible()))).toBe(true);
});

test('compact batch columns can resize while public account lookup preserves every unsaved draft field', async () => {
  test.setTimeout(120000);
  const dir = tempData('desktop-grid-lookup-'); await launch(dir); await setup(); await stubClipboard();
  const historyNotes = '开户业务 A\n需要保留的历史备注';
  const seeded = await page.evaluate(({ password, secret, notes }) => window.emailManager.mutateEmailData({ type: 'import', entries: [
    { id: 'lookup-chrome', email: 'shared@example.com', browser: 'Chrome', profile: 'Profile 1', group: '开户', tags: ['历史标签'], notes, launchUrl: 'https://example.com/history', password, totpSecret: secret },
    { id: 'lookup-firefox', email: 'shared@example.com', browser: 'Firefox', profile: '工作账号', group: '采购', notes: '采购业务 B', password: 'private-firefox-lookup-password' },
    { id: 'lookup-other', email: 'unrelated@example.com', browser: 'Edge', profile: 'Default', notes: '未分组业务 C' },
  ] }), { password: ACCOUNT_PASSWORD, secret: TOTP_SECRET, notes: historyNotes });
  expect(seeded.ok).toBe(true);
  // A filter on the main account page must not limit history available in entry.
  await page.getByLabel('搜索账号', { exact: true }).fill('shared@example.com');
  await expect(page.locator('.accounts-table tbody tr')).toHaveCount(2);
  await page.getByRole('button', { name: '批量录入', exact: true }).click();
  const grid = page.getByRole('dialog', { name: '批量录入账号', exact: true });
  const table = grid.getByRole('table', { name: '批量账号录入表格', exact: true });
  const widths = () => table.locator('thead th[data-batch-column]').evaluateAll(cells => cells.map(cell => Math.round(cell.getBoundingClientRect().width)));
  await expect(table.locator('thead th[data-batch-column]')).toHaveCount(7);
  expect(await widths()).toEqual([150, 80, 80, 80, 80, 80, 80]);
  for (const label of ['软件编号', '标签', '冷却小时', '启动网页']) {
    await expect(grid.getByLabel(`第 1 行 ${label}`, { exact: true })).toHaveCount(0);
  }
  const draft = { '邮箱资料': 'unfinished mailbox label', '浏览器': 'Brave', Profile: 'Profile+21', '备注': '尚未保存的备注\n第二行', '分组': '新业务', '密码': '  unsaved draft password  ', 'TOTP 密钥': TOTP_SECRET };
  for (const [label, value] of Object.entries(draft)) await grid.getByLabel(`第 1 行 ${label}`, { exact: true }).fill(value);
  const expectDraft = async () => {
    for (const [label, value] of Object.entries(draft)) await expect(grid.getByLabel(`第 1 行 ${label}`, { exact: true })).toHaveValue(value);
    await expect(grid.getByLabel('第 1 行 密码', { exact: true })).toHaveAttribute('type', 'password');
    await expect(grid.getByLabel('第 1 行 TOTP 密钥', { exact: true })).toHaveAttribute('type', 'password');
  };
  const profileResize = grid.getByRole('separator', { name: '调整Profile列宽', exact: true });
  await profileResize.press('ArrowRight');
  await expect(profileResize).toHaveAttribute('aria-valuenow', '88');
  expect((await widths())[2]).toBe(88);
  await profileResize.press('Home');
  await expect(profileResize).toHaveAttribute('aria-valuenow', '80');
  const notesResize = grid.getByRole('separator', { name: '调整备注列宽', exact: true });
  const grip = await notesResize.boundingBox();
  expect(grip).not.toBeNull();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down(); await page.mouse.move(grip.x + grip.width / 2 + 32, grip.y + grip.height / 2); await page.mouse.up();
  await expect(notesResize).toHaveAttribute('aria-valuenow', '112');
  expect((await widths())[3]).toBe(112);
  await grid.getByRole('button', { name: '列宽设置', exact: true }).click();
  const settings = grid.getByRole('group', { name: '录入列宽设置', exact: true });
  await settings.getByLabel('邮箱资料列宽', { exact: true }).fill('200');
  await settings.getByLabel('邮箱资料列宽', { exact: true }).press('Enter');
  expect((await widths())[0]).toBe(200);
  await settings.getByRole('button', { name: '恢复默认', exact: true }).click();
  expect(await widths()).toEqual([150, 80, 80, 80, 80, 80, 80]);
  await grid.getByRole('button', { name: '列宽设置', exact: true }).click();
  await expectDraft();
  await page.screenshot({ path: path.join(root, 'test-results', 'N7M-batch-compact.png'), fullPage: true });
  await grid.getByRole('button', { name: '查看已有账号', exact: true }).click();
  const history = grid.getByLabel('已有账号查询', { exact: true });
  const list = history.getByRole('list', { name: '已有账号列表', exact: true });
  const search = history.getByLabel('已有账号搜索', { exact: true });
  await expect(list.getByRole('listitem')).toHaveCount(3);
  await expect(history).not.toContainText(ACCOUNT_PASSWORD.trim());
  await expect(history).not.toContainText(TOTP_SECRET);
  await expect(history.locator('input[type="password"]')).toHaveCount(0);
  await history.getByRole('button', { name: '查看已有账号 shared@example.com Chrome Profile 1', exact: true }).click();
  const detail = history.getByLabel('已有账号详情', { exact: true });
  await expect(detail).toContainText(historyNotes);
  await expect(detail).toContainText('历史标签');
  await expect(detail).toContainText('https://example.com/history');
  await expect(detail.locator('.existing-credential-state')).toContainText('密码已设置');
  await expect(detail.locator('.existing-credential-state')).toContainText('TOTP 已设置');
  await detail.getByRole('button', { name: '复制已有账号备注', exact: true }).click();
  expect(await clipboardText()).toBe(historyNotes);
  await detail.getByRole('button', { name: '复制已有账号Profile', exact: true }).click();
  expect(await clipboardText()).toBe('Profile 1');
  await page.screenshot({ path: path.join(root, 'test-results', 'N7M-batch-history.png'), fullPage: true });
  // At a short, narrow viewport the stacked history remains scrollable and the
  // draft table and save button stay reachable without closing the lookup.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1050, 650));
  await expect.poll(() => page.evaluate(() => Math.max(Math.abs(innerWidth - 1050), Math.abs(innerHeight - 650))))
    .toBeLessThanOrEqual(3); // Windows DPI can round native content bounds by two pixels.
  expect(await grid.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return bounds.left >= 0 && bounds.top >= 0 && bounds.right <= innerWidth + 1 && bounds.bottom <= innerHeight + 1;
  })).toBe(true);
  await search.scrollIntoViewIfNeeded();
  await expect(search).toBeInViewport();
  const copyNotes = detail.getByRole('button', { name: '复制已有账号备注', exact: true });
  await copyNotes.scrollIntoViewIfNeeded();
  await expect(copyNotes).toBeInViewport();
  await copyNotes.click(); expect(await clipboardText()).toBe(historyNotes);
  await history.getByRole('button', { name: '已有账号下一页', exact: true }).scrollIntoViewIfNeeded();
  await expect(history.getByRole('button', { name: '已有账号下一页', exact: true })).toBeInViewport();
  await grid.getByRole('button', { name: '保存 1 个账号', exact: true }).scrollIntoViewIfNeeded();
  await expect(grid.getByRole('button', { name: '保存 1 个账号', exact: true })).toBeInViewport();
  await expectDraft();
  await page.screenshot({ path: path.join(root, 'test-results', 'N7M-batch-history-1050x650.png'), fullPage: true });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1500, 900));
  await expect.poll(() => page.evaluate(() => Math.max(Math.abs(innerWidth - 1500), Math.abs(innerHeight - 900))))
    .toBeLessThanOrEqual(3);
  await history.getByRole('button', { name: '查看已有账号 shared@example.com Firefox 工作账号', exact: true }).click();
  await expect(detail).toContainText('采购业务 B');
  await expect(detail).not.toContainText(historyNotes);
  await search.fill('历史标签');
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await expect(list).toContainText(historyNotes);
  for (const privateValue of [ACCOUNT_PASSWORD.trim(), TOTP_SECRET, 'private-firefox-lookup-password']) {
    await search.fill(privateValue);
    await expect(list.getByRole('listitem')).toHaveCount(0);
    await expect(list).toContainText('没有匹配的历史账号');
  }
  await search.fill('');
  const publicMarkup = await history.evaluate(element => element.outerHTML);
  for (const privateValue of [ACCOUNT_PASSWORD.trim(), TOTP_SECRET, 'private-firefox-lookup-password']) expect(publicMarkup).not.toContain(privateValue);
  await history.getByLabel('已有账号浏览器筛选', { exact: true }).selectOption('Firefox');
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await expect(list).toContainText('采购业务 B');
  await history.getByLabel('已有账号浏览器筛选', { exact: true }).selectOption('');
  await history.getByLabel('已有账号分组筛选', { exact: true }).selectOption('__none');
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await expect(list).toContainText('unrelated@example.com');
  await expectDraft();
  await history.getByRole('button', { name: '收起已有账号', exact: true }).click();
  await expect(history).toHaveCount(0);
  await expectDraft();
  await grid.getByRole('button', { name: '查看已有账号', exact: true }).click();
  await expect(history.getByRole('listitem')).toHaveCount(3);
  await grid.press('Escape');
  await expect(history).toHaveCount(0);
  await expect(grid).toBeVisible();
  await expectDraft();
  expect((await page.evaluate(() => window.emailManager.loadEmailData())).data.entries).toHaveLength(3);
  await grid.getByRole('button', { name: '保存 1 个账号', exact: true }).click();
  await expect(grid).toHaveCount(0);
  const saved = (await page.evaluate(() => window.emailManager.loadEmailData())).data;
  const newEntry = saved.entries.find(entry => entry.email === draft['邮箱资料']);
  expect(newEntry.notes).toBe(draft['备注']); expect(newEntry.group).toBe(draft['分组']);
  const credentials = await page.evaluate(id => window.emailManager.readEntrySecrets(id), newEntry.id);
  expect(credentials.password).toBe(draft['密码']); expect(credentials.totpSecret).toBe(TOTP_SECRET);
  expect(saved.entries).toHaveLength(4);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(win => !win.isVisible()))).toBe(true);
});

test('partial mailbox labels keep independent routes while batch and individual edits reject complete identity duplicates', async () => {
  test.setTimeout(120000);
  const dir = tempData('desktop-route-identity-'); await launch(dir); await setup();
  const label = 'shared-business';
  expect((await page.evaluate(({ email, password }) => window.emailManager.mutateEmailData({ type: 'import', entries: [
    { id: 'route-original', email, browser: 'Chrome', profile: 'Profile 43', notes: 'original route', password },
  ] }), { email: label, password: ACCOUNT_PASSWORD })).ok).toBe(true);
  await page.getByRole('button', { name: '批量录入', exact: true }).click();
  let editor = page.getByRole('dialog', { name: '批量录入账号', exact: true });
  const matrix = [
    ['SHARED-BUSINESS', 'chrome', '43', 'duplicate original', '', 'must not overwrite original', ''],
    [label, 'Chrome', 'Profile 44', 'independent Chrome route', '', 'chrome 44 secret', ''],
    [label, 'Edge', '43', 'independent Edge route', '', 'edge secret', ''],
    [label, 'Chrome', 'Profile+43', 'literal plus route', '', 'plus secret', ''],
    [label, 'Firefox', 'Work', 'Firefox uppercase', '', 'uppercase secret', ''],
    [label, 'Firefox', 'work', 'Firefox lowercase', '', 'lowercase secret', ''],
    ['SHARED-BUSINESS', 'Chrome', 'PROFILE 44', 'duplicate within batch', '', 'must not overwrite new route', ''],
  ].map(row => row.join('\t')).join('\r\n');
  await editor.getByLabel('第 1 行 邮箱资料', { exact: true }).evaluate((input, value) => {
    const data = new DataTransfer(); data.setData('text/plain', value);
    input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  }, matrix);
  await expect(editor.locator('.batch-entry-counts')).toContainText('重复跳过 2 个');
  await expect(editor.locator('.batch-entry-counts')).toContainText('可新增 5 个');
  await editor.getByRole('button', { name: '保存 5 个账号', exact: true }).click();
  await expect(editor).toHaveCount(0);
  let state = (await page.evaluate(() => window.emailManager.loadEmailData())).data;
  expect(state.entries).toHaveLength(6);
  expect(new Set(state.entries.map(entry => entry.id)).size).toBe(6);
  expect(state.entries.map(entry => entry.displayId)).toEqual(['001', '002', '003', '004', '005', '006']);
  expect(state.entries.every(entry => entry.email === label)).toBe(true);
  expect((await page.evaluate(() => window.emailManager.readEntrySecrets('route-original'))).password).toBe(ACCOUNT_PASSWORD);
  const chrome44 = state.entries.find(entry => entry.profile === 'Profile 44');
  expect((await page.evaluate(id => window.emailManager.readEntrySecrets(id), chrome44.id)).password).toBe('chrome 44 secret');
  await expectCounts(6, 6, 0, 0);
  // Single-account add has its own duplicate precheck and must use the same rule.
  await page.getByRole('button', { name: '添加账号', exact: true }).click();
  editor = page.getByRole('dialog', { name: '添加账号', exact: true });
  await editor.getByLabel('邮箱资料', { exact: true }).fill(label);
  await editor.getByLabel('浏览器', { exact: true }).selectOption('Brave');
  await editor.getByLabel('Profile', { exact: true }).fill('Default');
  await editor.getByRole('button', { name: '保存资料', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(page.locator('.accounts-table tbody tr')).toHaveCount(7);
  await page.getByRole('button', { name: '添加账号', exact: true }).click();
  editor = page.getByRole('dialog', { name: '添加账号', exact: true });
  await editor.getByLabel('邮箱资料', { exact: true }).fill(' SHARED-BUSINESS ');
  await editor.getByLabel('浏览器', { exact: true }).selectOption('Chrome');
  await editor.getByLabel('Profile', { exact: true }).fill('43');
  await editor.getByRole('button', { name: '保存资料', exact: true }).click();
  await expect(editor.getByRole('alert')).toContainText(/存在|重复/);
  expect((await page.evaluate(() => window.emailManager.loadEmailData())).data.entries).toHaveLength(7);
  await editor.getByRole('button', { name: '取消', exact: true }).click();
  // An existing record cannot be routed onto another account's exact identity.
  await rowFor(label).filter({ hasText: 'independent Chrome route' }).getByTitle('编辑账号', { exact: true }).click();
  editor = page.getByRole('dialog', { name: '编辑账号资料', exact: true });
  await editor.getByLabel('Profile', { exact: true }).fill('43');
  await editor.getByRole('button', { name: '保存资料', exact: true }).click();
  await expect(editor.getByRole('alert')).toContainText('组合重复');
  await editor.getByLabel('Profile', { exact: true }).fill('Profile 45');
  await editor.getByRole('button', { name: '保存资料', exact: true }).click();
  await expect(editor).toHaveCount(0);
  state = (await page.evaluate(() => window.emailManager.loadEmailData())).data;
  expect(state.entries.find(entry => entry.id === chrome44.id).profile).toBe('Profile 45');
  expect(state.entries).toHaveLength(7);
  expect((await page.evaluate(id => window.emailManager.readEntrySecrets(id), chrome44.id)).password).toBe('chrome 44 secret');
  expect((await page.evaluate(() => window.emailManager.readEntrySecrets('route-original'))).password).toBe(ACCOUNT_PASSWORD);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(win => !win.isVisible()))).toBe(true);
});

test('actual window lifecycle closes only its matching window and keeps pending, denied and uncertain windows safe', async () => {
  test.setTimeout(120000);
  const dir = tempData('desktop-live-windows-'); await launch(dir); await setup();
  await page.evaluate(() => window.emailManager.mutateEmailData({ type: 'import', entries: [
    { id: 'live-a', email: 'live-a@example.com', browser: 'Chrome', profile: 'Profile 1' },
    { id: 'live-b', email: 'live-b@example.com', browser: 'Chrome', profile: 'Profile 2' },
  ] }));
  const unrelated = await app.evaluate(async ({ app }) => {
    const req = process.getBuiltinModule('module').createRequire(`${app.getAppPath()}/package.json`);
    const launcher = req('./electron/browser-launch.cjs'); launcher.launch = async () => {};
    // This is an external browser window with no managed account or ownership tag.
    await launcher.launch({ browser: 'Chrome', profile: 'Profile 99' });
    return global.__n7mFakeWindows()[0];
  });
  const first = await page.evaluate(() => window.emailManager.openEntry('live-a'));
  const second = await page.evaluate(() => window.emailManager.openEntry('live-b'));
  expect(first.ok).toBe(true); expect(second.ok).toBe(true);
  const recordA = first.data.entries.find(entry => entry.id === 'live-a').browserWindow;
  const recordB = second.data.entries.find(entry => entry.id === 'live-b').browserWindow;
  expect(recordA.pid).toBe(recordB.pid); expect(recordA.pid).toBe(unrelated.pid);
  expect(new Set([recordA.hwnd, recordB.hwnd, unrelated.hwnd]).size).toBe(3);
  await expectCounts(2, 0, 2, 0);
  expect((await page.evaluate(() => window.emailManager.openEntry('live-a'))).ok).toBe(false);
  expect((await page.evaluate(() => window.emailManager.mutateEmailData({ type: 'update', ids: ['live-a'], patch: { profile: 'Profile 3' } }))).ok).toBe(false);
  expect((await page.evaluate(() => window.emailManager.mutateEmailData({ type: 'delete', ids: ['live-a'] }))).ok).toBe(false);
  // WM_CLOSE may wait for a browser's own unsaved/download confirmation.
  await app.evaluate(() => { global.__n7mClosePending = true; });
  const pending = await page.evaluate(() => window.emailManager.closeEntry('live-a'));
  expect(pending.ok).toBe(true); expect(pending.pending).toBe(true);
  expect(pending.data.openedIds).toContain('live-a');
  await expect(rowFor('live-a@example.com')).toHaveClass(/is-opened/);
  // Denied native closing must not clear a still-existing window or its timer.
  await app.evaluate(() => { global.__n7mClosePending = false; global.__n7mCloseDenied = true; });
  const denied = await page.evaluate(() => window.emailManager.closeEntry('live-a'));
  expect(denied.ok).toBe(false);
  expect((await page.evaluate(() => window.emailManager.loadEmailData())).data.openedIds).toContain('live-a');
  await app.evaluate(() => { global.__n7mCloseDenied = false; global.__n7mInspectUnknown = true; });
  const unknown = await page.evaluate(() => window.emailManager.refreshBrowserWindows());
  expect(unknown.ok).toBe(true); expect(unknown.data.canCloseIds).toEqual([]);
  expect(unknown.data.untrackedIds).toEqual(['live-a', 'live-b']);
  await expect(rowFor('live-a@example.com').getByRole('button', { name: '启动', exact: true })).toBeDisabled();
  expect((await page.evaluate(() => window.emailManager.closeEntry('live-a'))).ok).toBe(false);
  expect(await app.evaluate(() => global.__n7mFakeWindows().length)).toBe(3);
  await app.evaluate(() => { global.__n7mInspectUnknown = false; });
  await page.evaluate(() => window.emailManager.refreshBrowserWindows());
  await rowFor('live-b@example.com').getByRole('button', { name: '关闭浏览器', exact: true }).click();
  await expectCounts(2, 1, 1, 0);
  const remaining = await app.evaluate(() => global.__n7mFakeWindows());
  expect(remaining.map(record => record.hwnd).sort()).toEqual([unrelated.hwnd, recordA.hwnd].sort());
  const closedB = (await page.evaluate(() => window.emailManager.loadEmailData())).data.entries.find(entry => entry.id === 'live-b');
  expect(closedB.openedAt).toBe(null); expect(closedB.usedAt).toBe(null); expect(closedB.status).toBe('available');
  await expect(rowFor('live-b@example.com').getByRole('button', { name: '启动', exact: true })).toBeEnabled();
  // Closing outside N7M is discovered automatically, without clicking refresh.
  await app.evaluate((_electron, hwnd) => global.__n7mExternalClose(hwnd), recordA.hwnd);
  await expect(rowFor('live-a@example.com')).not.toHaveClass(/is-opened/, { timeout: 10000 });
  await expectCounts(2, 2, 0, 0);
  const closedA = (await page.evaluate(() => window.emailManager.loadEmailData())).data.entries.find(entry => entry.id === 'live-a');
  expect(closedA.openedAt).toBe(null); expect(closedA.usedAt).toBe(null); expect(closedA.status).toBe('available');
  expect((await app.evaluate(() => global.__n7mFakeWindows())).map(record => record.hwnd)).toEqual([unrelated.hwnd]);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(win => !win.isVisible()))).toBe(true);
});

test('compact layout shows at least six full accounts and keeps auxiliary tools, Profile and toolbar notes accessible', async () => {
  test.setTimeout(120000);
  const dir = tempData('desktop-compact-'); await launch(dir); await setup();
  const longNote = '工作用途：这个备注需要完整显示。\n第二行继续记录账号用途和注意事项，不应被省略号截断。';
  const entries = Array.from({ length: 18 }, (_, index) => ({ id: `compact-${index}`, email: `account-${String(index + 1).padStart(2, '0')}@example.com`,
    browser: ['Chrome', 'Edge', 'Brave'][index % 3], profile: `Profile ${index + 1}`, notes: index ? `常用账号 ${index + 1} 的备注` : longNote,
    group: index % 2 ? '项目' : '工作', tags: ['常用'] }));
  expect((await page.evaluate(entries => window.emailManager.mutateEmailData({ type: 'import', entries }), entries)).ok).toBe(true);
  const help = page.getByLabel('浏览器 Profile 查看方法', { exact: true });
  expect(await help.evaluate(element => element.open)).toBe(false);
  await expect(help.getByRole('button', { name: 'Chrome · chrome://version', exact: true })).not.toBeVisible();
  const auxiliary = page.getByRole('navigation', { name: '备用工具', exact: true });
  for (const name of ['冷却设置', '批量启动页设定', '导入资料']) await expect(auxiliary.getByRole('button', { name, exact: true })).toBeVisible();
  const header = page.locator('.app-header');
  for (const name of ['批量录入', '添加账号', '打开快捷栏', '导出资料', '清空全部账号']) await expect(header.getByRole('button', { name, exact: true })).toBeVisible();
  await app.evaluate(({ app }) => {
    const req = process.getBuiltinModule('module').createRequire(`${app.getAppPath()}/package.json`);
    req('./electron/browser-launch.cjs').launch = async () => {};
  });
  expect((await page.evaluate(() => window.emailManager.openEntry('compact-0'))).ok).toBe(true);
  expect((await page.evaluate(() => window.emailManager.openEntry('compact-1'))).ok).toBe(true);
  for (const [width, height] of [[1500, 900], [1280, 800]]) {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height), { width, height });
    // Native DPI rounding can add a couple of CSS pixels to Electron bounds.
    await expect.poll(() => page.evaluate(({ width, height }) => Math.abs(innerWidth - width) <= 3 && Math.abs(innerHeight - height) <= 3, { width, height })).toBe(true);
    const geometry = await page.locator('.table-scroll').evaluate(container => {
      const bounds = container.getBoundingClientRect(), head = container.querySelector('thead').getBoundingClientRect();
      const rows = [...container.querySelectorAll('tbody tr')].map(row => row.getBoundingClientRect());
      return { fullRows: rows.filter(row => row.top >= Math.max(head.bottom, bounds.top) - 1 && row.bottom <= Math.min(bounds.bottom, innerHeight) + 1).length,
        horizontalOverflow: container.scrollWidth > container.clientWidth + 1 };
    });
    expect(geometry.fullRows).toBeGreaterThanOrEqual(6);
    expect(geometry.horizontalOverflow).toBe(false);
    expect(await auxiliary.evaluate(element => element.getBoundingClientRect().top >= innerHeight * 0.65)).toBe(true);
    const auxiliaryFont = await auxiliary.getByRole('button', { name: '导入资料', exact: true }).evaluate(element => parseFloat(getComputedStyle(element).fontSize));
    expect(auxiliaryFont).toBeLessThanOrEqual(13);
    await page.screenshot({ path: path.join(root, 'test-results', `N7M-1.5.0-compact-${width}.png`), fullPage: true });
  }
  await header.getByRole('button', { name: '打开快捷栏', exact: true }).click();
  await expect.poll(() => app.windows().length).toBe(2);
  const toolbar = app.windows().find(window => window !== page);
  const note = toolbar.locator('.quick-card').filter({ hasText: 'account-01@example.com' }).locator('.quick-notes>span');
  await expect(note).toHaveText(longNote);
  expect(await note.evaluate(element => getComputedStyle(element).whiteSpace)).toBe('pre-wrap');
  expect(await note.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThan(30);
  await expect(toolbar.locator('.quick-card').filter({ hasText: 'account-01@example.com' }).getByRole('button', { name: '关闭浏览器', exact: true })).toBeEnabled();
  await toolbar.screenshot({ path: path.join(root, 'test-results', 'N7M-1.5.0-toolbar.png') });
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(win => !win.isVisible()))).toBe(true);
});

test('upgrading historical launch markers clears obsolete cooldowns without requiring manual cleanup', async () => {
  const dir = tempData('desktop-old-markers-'), timestamp = Date.now() - 1000;
  fs.writeFileSync(path.join(dir, 'email-data.json'), JSON.stringify([
    { id: 'old-marker', email: 'previously-closed@example.com', browser: 'Chrome', openedAt: timestamp, usedAt: timestamp, status: 'used' },
  ]));
  await launch(dir); await setup();
  const loaded = (await page.evaluate(() => window.emailManager.loadEmailData())).data;
  expect(loaded.openedIds).toEqual([]); expect(loaded.untrackedIds).toEqual([]);
  expect(loaded.entries[0].openedAt).toBe(null); expect(loaded.entries[0].usedAt).toBe(null); expect(loaded.entries[0].status).toBe('available');
  await expect(rowFor('previously-closed@example.com').getByRole('button', { name: '启动', exact: true })).toBeEnabled();
  await expectCounts(1, 1, 0, 0);
});

test('secure per-row editor requires reauthentication, edits distinct credentials atomically and discards drafts on relock', async () => {
  test.setTimeout(180000);
  const dir = tempData('desktop-bulk-secure-'); await launch(dir); await setup();
  const initial = [
    { id: 'edit-a', email: 'edit-a@example.com', browser: 'Chrome', profile: 'Profile 1', notes: 'original A', group: '工作', password: ACCOUNT_PASSWORD, totpSecret: TOTP_SECRET },
    { id: 'edit-b', email: 'edit-b@example.com', browser: 'Firefox', profile: '工作账号', notes: 'original B', group: '项目', password: 'original B password' },
    { id: 'edit-outside', email: 'outside@example.com', browser: 'Edge', notes: 'outside unchanged', password: 'outside password' },
  ];
  expect((await page.evaluate(entries => window.emailManager.mutateEmailData({ type: 'import', entries }), initial)).ok).toBe(true);
  // A filtered scope loads only these two accounts after the password check.
  await page.getByLabel('搜索账号', { exact: true }).fill('edit-');
  await page.getByRole('button', { name: '批量修改', exact: true }).click();
  let editor = page.getByRole('dialog', { name: '批量修改账号资料', exact: true });
  await expect(editor.locator('.bulk-edit-table')).toHaveCount(0);
  await expect(editor.getByLabel('批量编辑软件密码', { exact: true })).toHaveAttribute('type', 'password');
  await expect(editor).not.toContainText(ACCOUNT_PASSWORD.trim());
  await editor.getByLabel('批量编辑软件密码', { exact: true }).fill('incorrect bulk password');
  await editor.getByRole('button', { name: '验证密码并编辑', exact: true }).click();
  await expect(editor.getByRole('alert')).toContainText(/密码|验证/);
  await expect(editor.locator('.bulk-edit-table')).toHaveCount(0);
  await editor.getByLabel('批量编辑软件密码', { exact: true }).fill(MASTER);
  await editor.getByRole('button', { name: '验证密码并编辑', exact: true }).click();
  await expect(editor.locator('tbody tr')).toHaveCount(2);
  await expect(editor.getByLabel('第 1 行 密码', { exact: true })).toHaveAttribute('type', 'password');
  await expect(editor.getByLabel('第 1 行 TOTP 密钥', { exact: true })).toHaveAttribute('type', 'password');
  await expect(editor).not.toContainText(ACCOUNT_PASSWORD.trim());
  await expect(editor).not.toContainText(TOTP_SECRET);
  const nextA = '  updated account A password  ', nextB = 'updated account B password';
  await editor.getByLabel('第 1 行 密码', { exact: true }).fill(nextA);
  await editor.getByLabel('第 2 行 密码', { exact: true }).fill(nextB);
  await editor.getByLabel('第 1 行 备注', { exact: true }).fill('A 按行修改后的备注');
  await editor.getByLabel('第 2 行 备注', { exact: true }).fill('B 另一份备注');
  await editor.getByLabel('第 2 行 邮箱资料', { exact: true }).fill('edit-b-renamed@example.com');
  await editor.getByLabel('第 2 行 TOTP 密钥', { exact: true }).fill(TOTP_SECRET);
  await page.screenshot({ path: path.join(root, 'test-results', 'N7M-1.6.0-bulk-edit.png'), fullPage: true });
  await editor.getByRole('button', { name: '保存 2 个账号的修改', exact: true }).click();
  await expect(editor).toHaveCount(0);
  const changed = (await page.evaluate(() => window.emailManager.loadEmailData())).data;
  expect(changed.entries.find(entry => entry.id === 'edit-a').notes).toBe('A 按行修改后的备注');
  expect(changed.entries.find(entry => entry.id === 'edit-b').email).toBe('edit-b-renamed@example.com');
  expect(changed.entries.find(entry => entry.id === 'edit-b').profile).toBe('工作账号');
  expect(changed.entries.find(entry => entry.id === 'edit-outside').notes).toBe('outside unchanged');
  const credentials = await page.evaluate(async () => Promise.all(['edit-a', 'edit-b', 'edit-outside'].map(id => window.emailManager.readEntrySecrets(id))));
  expect(credentials.map(entry => entry.password)).toEqual([nextA, nextB, 'outside password']);
  expect(credentials[0].totpSecret).toBe(TOTP_SECRET); expect(credentials[1].totpSecret).toBe(TOTP_SECRET);
  const encrypted = fs.readFileSync(path.join(dir, 'email-vault.json'), 'utf8');
  for (const secret of ['edit-a@example.com', nextA.trim(), nextB, TOTP_SECRET]) expect(encrypted).not.toContain(secret);
  // Explicitly relocking removes all loaded credential cells and unsaved input.
  await page.getByRole('button', { name: '批量修改', exact: true }).click();
  editor = page.getByRole('dialog', { name: '批量修改账号资料', exact: true });
  await editor.getByLabel('批量编辑软件密码', { exact: true }).fill(MASTER);
  await editor.getByRole('button', { name: '验证密码并编辑', exact: true }).click();
  await expect(editor.locator('tbody tr')).toHaveCount(2);
  await editor.getByLabel('第 1 行 密码', { exact: true }).fill('unsaved-bulk-secret');
  await editor.getByRole('button', { name: '重新锁定', exact: true }).click();
  await expect(editor.locator('.bulk-edit-table')).toHaveCount(0);
  await expect(editor.getByLabel('批量编辑软件密码', { exact: true })).toHaveValue('');
  await editor.getByLabel('批量编辑软件密码', { exact: true }).fill(MASTER);
  await editor.getByRole('button', { name: '验证密码并编辑', exact: true }).click();
  await expect(editor.getByLabel('第 1 行 密码', { exact: true })).toHaveValue(nextA);
  await app.evaluate(({ powerMonitor }) => powerMonitor.emit('lock-screen'));
  await expect(page.getByRole('button', { name: '解锁', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await unlock();
  expect((await page.evaluate(() => window.emailManager.readEntrySecrets('edit-a'))).password).toBe(nextA);
});

test('bulk edit capabilities enforce scope, atomic conflicts, explicit revocation and lock generation without overwriting unrelated changes', async () => {
  test.setTimeout(180000);
  const dir = tempData('desktop-bulk-capabilities-'); await launch(dir); await setup();
  await page.evaluate(() => window.emailManager.mutateEmailData({ type: 'import', entries: [
    { id: 'cap-a', email: 'cap-a@example.com', browser: 'Chrome', notes: 'baseline A', password: 'original A' },
    { id: 'cap-b', email: 'cap-b@example.com', browser: 'Edge', notes: 'baseline B', password: 'original B' },
  ] }));
  const rejectedAuth = await page.evaluate(() => window.emailManager.beginBulkEdit('wrong password', ['cap-a']));
  expect(rejectedAuth.ok).toBe(false); expect(Object.hasOwn(rejectedAuth, 'entries')).toBe(false);
  const scoped = await page.evaluate(master => window.emailManager.beginBulkEdit(master, ['cap-a']), MASTER);
  expect(scoped.ok).toBe(true); expect(scoped.entries.map(entry => entry.id)).toEqual(['cap-a']);
  expect(scoped.entries[0].password).toBe('original A');
  const scopeViolation = await page.evaluate(token => window.emailManager.applyBulkEdit({ token, patches: [{ id: 'cap-b', patch: { password: 'scope bypass' } }] }), scoped.token);
  expect(scopeViolation.ok).toBe(false);
  expect((await page.evaluate(() => window.emailManager.readEntrySecrets('cap-b'))).password).toBe('original B');
  await page.evaluate(token => window.emailManager.revokeBulkEdit(token), scoped.token);
  expect((await page.evaluate(token => window.emailManager.applyBulkEdit({ token, patches: [{ id: 'cap-a', patch: { notes: 'revoked' } }] }), scoped.token)).ok).toBe(false);
  const conflicting = await page.evaluate(master => window.emailManager.beginBulkEdit(master, ['cap-a', 'cap-b']), MASTER);
  expect(conflicting.ok).toBe(true);
  await page.evaluate(() => window.emailManager.mutateEmailData({ type: 'update', ids: ['cap-a'], patch: { notes: 'concurrent note A' } }));
  const conflict = await page.evaluate(token => window.emailManager.applyBulkEdit({ token, patches: [
    { id: 'cap-a', patch: { notes: 'stale overwrite' } }, { id: 'cap-b', patch: { password: 'must remain unsaved' } },
  ] }), conflicting.token);
  expect(conflict.ok).toBe(false);
  const afterConflict = (await page.evaluate(() => window.emailManager.loadEmailData())).data;
  expect(afterConflict.entries.find(entry => entry.id === 'cap-a').notes).toBe('concurrent note A');
  expect((await page.evaluate(() => window.emailManager.readEntrySecrets('cap-b'))).password).toBe('original B');
  // A global revision change in an unrelated field is not itself a conflict.
  const mergeable = await page.evaluate(master => window.emailManager.beginBulkEdit(master, ['cap-a']), MASTER);
  await page.evaluate(() => window.emailManager.mutateEmailData({ type: 'update', ids: ['cap-a'], patch: { notes: 'newer note must survive' } }));
  const merged = await page.evaluate(token => window.emailManager.applyBulkEdit({ token, revision: 0, patches: [{ id: 'cap-a', patch: { password: 'merged credential' } }] }), mergeable.token);
  expect(merged.ok).toBe(true);
  expect(merged.data.entries.find(entry => entry.id === 'cap-a').notes).toBe('newer note must survive');
  expect((await page.evaluate(() => window.emailManager.readEntrySecrets('cap-a'))).password).toBe('merged credential');
  expect((await page.evaluate(token => window.emailManager.applyBulkEdit({ token, patches: [{ id: 'cap-a', patch: { password: 'replayed' } }] }), mergeable.token)).ok).toBe(false);
  const lockedToken = await page.evaluate(master => window.emailManager.beginBulkEdit(master, ['cap-a']), MASTER);
  await page.getByRole('button', { name: '锁定', exact: true }).click();
  await unlock();
  expect((await page.evaluate(token => window.emailManager.applyBulkEdit({ token, patches: [{ id: 'cap-a', patch: { password: 'after lock' } }] }), lockedToken.token)).ok).toBe(false);
  expect((await page.evaluate(() => window.emailManager.readEntrySecrets('cap-a'))).password).toBe('merged credential');
  const senderToken = await page.evaluate(master => window.emailManager.beginBulkEdit(master, ['cap-a']), MASTER);
  await page.getByRole('button', { name: '打开快捷栏', exact: true }).click();
  await expect.poll(() => app.windows().length).toBe(2);
  const toolbar = app.windows().find(window => window !== page);
  const otherSender = await toolbar.evaluate(token => window.emailManager.applyBulkEdit({ token, patches: [{ id: 'cap-a', patch: { password: 'cross-window' } }] }), senderToken.token);
  expect(otherSender.ok).toBe(false);
  expect((await page.evaluate(() => window.emailManager.readEntrySecrets('cap-a'))).password).toBe('merged credential');
  const newPassword = await page.evaluate(({ current, next }) => window.emailManager.changeVaultPassword(current, next), { current: MASTER, next: NEXT_MASTER });
  expect(newPassword.ok).toBe(true);
  expect((await page.evaluate(token => window.emailManager.applyBulkEdit({ token, patches: [{ id: 'cap-a', patch: { notes: 'after password rotation' } }] }), senderToken.token)).ok).toBe(false);
});

test('encrypted export restores passwords and TOTP through the file UI without carrying browser window identities', async () => {
  test.setTimeout(180000);
  const dir = tempData('desktop-backup-ui-'); await launch(dir); await setup();
  const accounts = [
    { id: 'backup-a', email: 'backup-a@example.com', browser: 'Chrome', profile: 'Profile 1', group: '工作', notes: 'private backup note', password: ACCOUNT_PASSWORD, totpSecret: TOTP_SECRET },
    { id: 'backup-b', email: 'backup-b@example.com', browser: 'Firefox', profile: '工作账号', group: '项目', notes: 'backup B', password: 'B backup password' },
  ];
  expect((await page.evaluate(entries => window.emailManager.mutateEmailData({ type: 'import', entries }), accounts)).ok).toBe(true);
  await app.evaluate(({ app }) => {
    const req = process.getBuiltinModule('module').createRequire(`${app.getAppPath()}/package.json`);
    req('./electron/browser-launch.cjs').launch = async () => {};
  });
  expect((await page.evaluate(() => window.emailManager.openEntry('backup-a'))).ok).toBe(true);
  const backupPath = path.join(dir, 'complete.n7mbackup');
  await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, backupPath);
  await page.getByRole('button', { name: '导出资料', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: '导出资料', exact: true });
  await expect(dialog.getByRole('radio', { name: /^加密完整备份/ })).toBeChecked();
  await dialog.getByLabel('导出软件密码', { exact: true }).fill('incorrect export password');
  await dialog.getByRole('button', { name: '导出加密备份', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText(/密码|验证/);
  expect(fs.existsSync(backupPath)).toBe(false);
  await dialog.getByLabel('导出软件密码', { exact: true }).fill(MASTER);
  await dialog.getByRole('button', { name: '导出加密备份', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => fs.existsSync(backupPath)).toBe(true);
  const encrypted = fs.readFileSync(backupPath, 'utf8');
  for (const marker of ['backup-a@example.com', 'private backup note', ACCOUNT_PASSWORD.trim(), 'B backup password', TOTP_SECRET]) expect(encrypted).not.toContain(marker);
  expect(JSON.parse(encrypted).format).toBe('N7M-BACKUP');
  // Restore onto an empty vault while retaining its established software password.
  expect((await page.evaluate(() => window.emailManager.closeEntry('backup-a'))).ok).toBe(true);
  expect((await page.evaluate(() => window.emailManager.mutateEmailData({ type: 'delete', ids: ['backup-a', 'backup-b'] }))).ok).toBe(true);
  await page.getByRole('button', { name: '导出资料', exact: true }).click();
  await page.getByRole('button', { name: '恢复备份', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '恢复加密备份', exact: true });
  await dialog.locator('input[type=file]').setInputFiles(backupPath);
  await dialog.getByLabel('备份密码', { exact: true }).fill('wrong backup password');
  await dialog.getByRole('button', { name: '检查备份', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText(/密码|损坏/);
  expect((await page.evaluate(() => window.emailManager.loadEmailData())).data.entries).toHaveLength(0);
  await dialog.getByLabel('备份密码', { exact: true }).fill(MASTER);
  await dialog.getByRole('button', { name: '检查备份', exact: true }).click();
  await expect(dialog.locator('.backup-review')).toContainText('备份含 2 个账号');
  await expect(dialog.locator('.backup-review')).toContainText('2 个新增');
  for (const secret of [ACCOUNT_PASSWORD.trim(), 'B backup password', TOTP_SECRET, 'backup-a@example.com']) await expect(dialog).not.toContainText(secret);
  await page.screenshot({ path: path.join(root, 'test-results', 'N7M-1.6.0-backup-preview.png'), fullPage: true });
  await dialog.getByRole('button', { name: '确认恢复资料', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const restored = (await page.evaluate(() => window.emailManager.loadEmailData())).data;
  expect(restored.entries).toHaveLength(2); expect(restored.openedIds).toEqual([]); expect(restored.canCloseIds).toEqual([]);
  expect(restored.groups).toEqual(expect.arrayContaining(['工作', '项目']));
  for (const entry of restored.entries) {
    expect(entry.openedAt).toBe(null); expect(entry.usedAt).toBe(null); expect(entry.status).toBe('available');
    expect(entry.browserWindow == null).toBe(true); expect(entry.browserTracking == null).toBe(true);
  }
  const first = restored.entries.find(entry => entry.email === 'backup-a@example.com'), second = restored.entries.find(entry => entry.email === 'backup-b@example.com');
  const restoredSecrets = await page.evaluate(async ({ first, second }) => Promise.all([window.emailManager.readEntrySecrets(first), window.emailManager.readEntrySecrets(second)]), { first: first.id, second: second.id });
  expect(restoredSecrets[0].password).toBe(ACCOUNT_PASSWORD); expect(restoredSecrets[0].totpSecret).toBe(TOTP_SECRET);
  expect(restoredSecrets[1].password).toBe('B backup password'); expect(second.browser).toBe('Firefox'); expect(second.profile).toBe('工作账号');
  await app.close(); app = null; await launch(dir); await unlock();
  expect((await page.evaluate(id => window.emailManager.readEntrySecrets(id), first.id)).password).toBe(ACCOUNT_PASSWORD);
  // A historical backup can use an older password while the current vault
  // still requires its newly changed master password for restore permission.
  expect((await page.evaluate(({ current, next }) => window.emailManager.changeVaultPassword(current, next), { current: MASTER, next: NEXT_MASTER })).ok).toBe(true);
  await page.getByRole('button', { name: '导出资料', exact: true }).click();
  await page.getByRole('button', { name: '恢复备份', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '恢复加密备份', exact: true });
  await dialog.locator('input[type=file]').setInputFiles(backupPath);
  await expect(dialog.getByLabel('备份密码与当前软件密码相同', { exact: true })).toBeChecked();
  await dialog.getByLabel('备份密码与当前软件密码相同', { exact: true }).uncheck();
  await dialog.getByLabel('备份密码', { exact: true }).fill(MASTER);
  await dialog.getByLabel('恢复当前软件密码', { exact: true }).fill(NEXT_MASTER);
  await dialog.getByRole('button', { name: '检查备份', exact: true }).click();
  await expect(dialog.locator('.backup-review')).toContainText('备份含 2 个账号');
  await dialog.getByRole('button', { name: '关闭备份窗口', exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test('backup restore policies preserve or replace credentials explicitly and reject tampering, wrong passwords and revoked previews', async () => {
  test.setTimeout(180000);
  const dir = tempData('desktop-backup-policies-'); await launch(dir); await setup();
  await page.evaluate(({ password, secret }) => window.emailManager.mutateEmailData({ type: 'import', entries: [
    { id: 'policy-a', email: 'policy-a@example.com', browser: 'Chrome', notes: 'backup note', password, totpSecret: secret },
    { id: 'policy-b', email: 'policy-b@example.com', browser: 'Firefox', profile: '项目账号', password: 'backup B secret' },
  ] }), { password: ACCOUNT_PASSWORD, secret: TOTP_SECRET });
  // Neither export format may overwrite the active vault or its recovery copy.
  for (const destination of [path.join(dir, 'email-vault.json'), path.join(dir, 'email-vault.json.bak')]) {
    const protectedBytes = fs.readFileSync(destination);
    await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, destination);
    expect((await page.evaluate(() => window.emailManager.exportEmailData())).ok).toBe(false);
    expect(fs.readFileSync(destination).equals(protectedBytes)).toBe(true);
    expect((await page.evaluate(master => window.emailManager.exportEncryptedBackup(undefined, master), MASTER)).ok).toBe(false);
    expect(fs.readFileSync(destination).equals(protectedBytes)).toBe(true);
  }
  const backupPath = path.join(dir, 'policies.n7mbackup');
  await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, backupPath);
  const exported = await page.evaluate(master => window.emailManager.exportEncryptedBackup(undefined, master), MASTER);
  expect(exported.ok).toBe(true);
  const bytes = [...fs.readFileSync(backupPath)];
  await page.evaluate(() => window.emailManager.mutateEmailData({ type: 'update', ids: ['policy-a'], patch: { password: 'local password', totpSecret: '', notes: 'keep local note' } }));
  await page.evaluate(() => window.emailManager.mutateEmailData({ type: 'delete', ids: ['policy-b'] }));
  const revisionBefore = (await page.evaluate(() => window.emailManager.loadEmailData())).data.revision;
  const wrong = await page.evaluate(({ bytes, master }) => window.emailManager.previewBackup(new Uint8Array(bytes), master), { bytes, master: 'wrong import password' });
  expect(wrong.ok).toBe(false); expect(Object.hasOwn(wrong, 'entries')).toBe(false);
  const alteredEnvelope = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
  const alteredCipher = Buffer.from(alteredEnvelope.data, 'base64'); alteredCipher[0] ^= 1; alteredEnvelope.data = alteredCipher.toString('base64');
  const tampered = [...Buffer.from(JSON.stringify(alteredEnvelope))];
  expect((await page.evaluate(({ bytes, master }) => window.emailManager.previewBackup(new Uint8Array(bytes), master), { bytes: tampered, master: MASTER })).ok).toBe(false);
  expect((await page.evaluate(() => window.emailManager.loadEmailData())).data.revision).toBe(revisionBefore);
  const preview = await page.evaluate(({ bytes, master }) => window.emailManager.previewBackup(new Uint8Array(bytes), master), { bytes, master: MASTER });
  expect(preview.ok).toBe(true); expect(preview.total).toBe(2); expect(preview.newCount).toBe(1); expect(preview.existingCount).toBe(1);
  expect(Object.hasOwn(preview, 'entries')).toBe(false); expect(JSON.stringify(preview)).not.toContain(TOTP_SECRET);
  const filled = await page.evaluate(token => window.emailManager.restoreBackup({ token, policy: 'fill', restoreSettings: false }), preview.token);
  expect(filled.ok).toBe(true); expect(filled.data.entries).toHaveLength(2);
  let secretA = await page.evaluate(() => window.emailManager.readEntrySecrets('policy-a'));
  expect(secretA.password).toBe('local password'); expect(secretA.totpSecret).toBe(TOTP_SECRET);
  expect(filled.data.entries.find(entry => entry.id === 'policy-a').notes).toBe('keep local note');
  const importedB = filled.data.entries.find(entry => entry.email === 'policy-b@example.com');
  expect((await page.evaluate(id => window.emailManager.readEntrySecrets(id), importedB.id)).password).toBe('backup B secret');
  expect((await page.evaluate(token => window.emailManager.restoreBackup({ token, policy: 'overwrite', restoreSettings: false }), preview.token)).ok).toBe(false);
  // Preview permission is not permission to discard a later credential edit.
  await page.evaluate(id => window.emailManager.mutateEmailData({ type: 'update', ids: [id], patch: { notes: 'preserve B if restore conflicts' } }), importedB.id);
  const stalePreview = await page.evaluate(({ bytes, master }) => window.emailManager.previewBackup(new Uint8Array(bytes), master), { bytes, master: MASTER });
  expect(stalePreview.ok).toBe(true);
  await page.evaluate(() => window.emailManager.mutateEmailData({ type: 'update', ids: ['policy-a'], patch: { password: 'credential changed after preview' } }));
  const staleRestore = await page.evaluate(token => window.emailManager.restoreBackup({ token, policy: 'overwrite', restoreSettings: false }), stalePreview.token);
  expect(staleRestore.ok).toBe(false);
  expect((await page.evaluate(() => window.emailManager.readEntrySecrets('policy-a'))).password).toBe('credential changed after preview');
  expect((await page.evaluate(() => window.emailManager.loadEmailData())).data.entries.find(entry => entry.id === importedB.id).notes).toBe('preserve B if restore conflicts');
  const replacing = await page.evaluate(({ bytes, master }) => window.emailManager.previewBackup(new Uint8Array(bytes), master), { bytes, master: MASTER });
  expect((await page.evaluate(token => window.emailManager.restoreBackup({ token, policy: 'overwrite', restoreSettings: false }), replacing.token)).ok).toBe(true);
  secretA = await page.evaluate(() => window.emailManager.readEntrySecrets('policy-a'));
  expect(secretA.password).toBe(ACCOUNT_PASSWORD); expect(secretA.totpSecret).toBe(TOTP_SECRET);
  await page.evaluate(() => window.emailManager.mutateEmailData({ type: 'update', ids: ['policy-a'], patch: { password: 'do not replace when adding only' } }));
  const adding = await page.evaluate(({ bytes, master }) => window.emailManager.previewBackup(new Uint8Array(bytes), master), { bytes, master: MASTER });
  expect((await page.evaluate(token => window.emailManager.restoreBackup({ token, policy: 'add', restoreSettings: false }), adding.token)).ok).toBe(true);
  expect((await page.evaluate(() => window.emailManager.readEntrySecrets('policy-a'))).password).toBe('do not replace when adding only');
  const revoked = await page.evaluate(({ bytes, master }) => window.emailManager.previewBackup(new Uint8Array(bytes), master), { bytes, master: MASTER });
  await page.evaluate(token => window.emailManager.revokeBackupPreview(token), revoked.token);
  expect((await page.evaluate(token => window.emailManager.restoreBackup({ token, policy: 'fill', restoreSettings: false }), revoked.token)).ok).toBe(false);
  // Existing backup passwords remain the export-time password after rotation.
  expect((await page.evaluate(({ current, next }) => window.emailManager.changeVaultPassword(current, next), { current: MASTER, next: NEXT_MASTER })).ok).toBe(true);
  const oldBackupPasswordAlone = await page.evaluate(({ bytes, master }) => window.emailManager.previewBackup(new Uint8Array(bytes), master), { bytes, master: MASTER });
  expect(oldBackupPasswordAlone.ok).toBe(false); expect(Object.hasOwn(oldBackupPasswordAlone, 'token')).toBe(false);
  const historical = await page.evaluate(({ bytes, master, current }) => window.emailManager.previewBackup(new Uint8Array(bytes), master, current), { bytes, master: MASTER, current: NEXT_MASTER });
  expect(historical.ok).toBe(true);
  expect((await page.evaluate(token => window.emailManager.restoreBackup({ token, policy: 'overwrite', restoreSettings: false }), historical.token)).ok).toBe(true);
  const beforeLock = await page.evaluate(({ bytes, master, current }) => window.emailManager.previewBackup(new Uint8Array(bytes), master, current), { bytes, master: MASTER, current: NEXT_MASTER });
  await page.getByRole('button', { name: '锁定', exact: true }).click(); await unlock(NEXT_MASTER);
  expect((await page.evaluate(token => window.emailManager.restoreBackup({ token, policy: 'fill', restoreSettings: false }), beforeLock.token)).ok).toBe(false);
  expect((await page.evaluate(() => window.emailManager.readEntrySecrets('policy-a'))).password).toBe(ACCOUNT_PASSWORD);
});

test('Firefox named profiles launch unchanged and copy help without acquiring close authority', async () => {
  const dir = tempData('desktop-firefox-'); await launch(dir); await setup(); await stubClipboard();
  await page.getByRole('button', { name: '添加账号', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '添加账号', exact: true });
  await editor.getByLabel('邮箱资料', { exact: true }).fill('firefox@example.com');
  await editor.getByLabel('浏览器', { exact: true }).selectOption('Firefox');
  await editor.getByLabel('Profile', { exact: true }).fill('工作 火狐账号');
  await editor.getByRole('button', { name: '保存资料', exact: true }).click();
  await expect(editor).toHaveCount(0);
  const entry = (await page.evaluate(() => window.emailManager.loadEmailData())).data.entries[0];
  expect(entry.browser).toBe('Firefox'); expect(entry.profile).toBe('工作 火狐账号');
  const help = page.getByLabel('浏览器 Profile 查看方法', { exact: true });
  await help.locator('summary').click();
  await help.getByRole('button', { name: 'Firefox · about:profiles', exact: true }).click();
  expect(await clipboardText()).toBe('about:profiles');
  await help.locator('summary').click();
  await app.evaluate(({ app }) => {
    const req = process.getBuiltinModule('module').createRequire(`${app.getAppPath()}/package.json`);
    req('./electron/browser-launch.cjs').launch = async entry => { global.__n7mFirefoxLaunch = { ...entry }; };
  });
  await rowFor('firefox@example.com').getByRole('button', { name: '启动', exact: true }).click();
  await expect(rowFor('firefox@example.com')).not.toHaveClass(/is-opened/);
  await expect(rowFor('firefox@example.com').locator('.status-stack')).toContainText('未关联窗口');
  const opened = (await page.evaluate(() => window.emailManager.loadEmailData())).data;
  expect(opened.canCloseIds).toEqual([]); expect(opened.openedIds).toEqual([]);
  expect(opened.entries[0].browserWindow == null).toBe(true);
  expect(opened.entries[0].browserTracking).toBe('unmanaged'); expect(opened.entries[0].browserTrackingReason).toBe('identity');
  expect(opened.entries[0].openedAt).toBe(null); expect(opened.entries[0].usedAt).toBe(null);
  expect(await app.evaluate(() => global.__n7mFirefoxLaunch)).toEqual({ browser: 'Firefox', profile: '工作 火狐账号', launchUrl: '' });
  await expect(rowFor('firefox@example.com').getByRole('button', { name: '关闭浏览器', exact: true })).toHaveCount(0);
  await expect(rowFor('firefox@example.com').getByRole('button', { name: '启动', exact: true })).toBeEnabled();
  expect(await app.evaluate(() => global.__n7mCloseRequests)).toEqual([]);
  expect((await app.evaluate(() => global.__n7mFakeWindows())).map(record => record.profile)).toEqual(['工作 火狐账号']);
});

test('literal plus Profile can be added, edited and launched without changing the selected Brave directory', async () => {
  const dir = tempData('desktop-profile-plus-'); await launch(dir, true); await setup();
  await page.getByRole('button', { name: '批量录入', exact: true }).click();
  let editor = page.getByRole('dialog', { name: '批量录入账号', exact: true });
  await editor.getByLabel('第 1 行 邮箱资料', { exact: true }).fill('plus-profile@example.com');
  await editor.getByLabel('第 1 行 浏览器', { exact: true }).fill('Brave');
  await editor.getByLabel('第 1 行 Profile', { exact: true }).fill('Profile+21');
  await editor.getByRole('button', { name: '保存 1 个账号', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(rowFor('plus-profile@example.com')).toContainText('Profile+21');
  await expect(rowFor('plus-profile@example.com')).not.toContainText('待完善');
  // The per-row editor uses a separate validation/commit path from adding.
  await rowFor('plus-profile@example.com').getByTitle('编辑账号', { exact: true }).click();
  editor = page.getByRole('dialog', { name: '编辑账号资料', exact: true });
  await editor.getByLabel('Profile', { exact: true }).fill('Work+Team');
  await editor.getByRole('button', { name: '保存资料', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(rowFor('plus-profile@example.com')).toContainText('Work+Team');
  await page.getByRole('button', { name: '批量修改', exact: true }).click();
  editor = page.getByRole('dialog', { name: '批量修改账号资料', exact: true });
  await editor.getByLabel('批量编辑软件密码', { exact: true }).fill(MASTER);
  await editor.getByRole('button', { name: '验证密码并编辑', exact: true }).click();
  await editor.getByLabel('第 1 行 Profile', { exact: true }).fill('Profile+21');
  await editor.getByRole('button', { name: '保存 1 个账号的修改', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await app.evaluate(({ app }) => {
    const requireFromApp = process.getBuiltinModule('module').createRequire(`${app.getAppPath()}/package.json`);
    const launcher = requireFromApp('./electron/browser-launch.cjs');
    launcher.launch = async entry => { global.__n7mPlusArgs = launcher.browserArgs(entry, ''); };
  });
  await rowFor('plus-profile@example.com').getByRole('button', { name: '启动', exact: true }).click();
  await expect(rowFor('plus-profile@example.com')).toHaveClass(/is-opened/);
  expect(await app.evaluate(() => global.__n7mPlusArgs)).toEqual(['--profile-directory=Profile+21', '--new-window']);
  const saved = await page.evaluate(() => window.emailManager.loadEmailData());
  expect(saved.data.entries[0].profile).toBe('Profile+21');
  expect(saved.data.entries[0].browserWindow.profile).toBe('Profile+21');
});

test.afterEach(async () => { if (app) { await app.close(); app = null; } });
