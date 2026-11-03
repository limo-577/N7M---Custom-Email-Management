const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ExcelJS = require('exceljs');
const JSZip = require('jszip');
const root = path.resolve(__dirname, '..');
const MASTER = 'N7M-test-pass123!';
const NEXT_MASTER = 'N7M-next-pass456!';
const ACCOUNT_PASSWORD = '  Demo-account-password!  ';
const TOTP_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
let app, page;
const rowFor = email => page.locator('.accounts-table tbody tr').filter({ hasText: email });
async function expectCounts(total, ready, cooling, incomplete) {
  const summary = page.getByLabel('账号统计', { exact: true });
  await expect(summary).toBeVisible();
  await expect(summary.locator(':scope > span')).toHaveText([
    new RegExp(`^全部账号\\s*${total}$`), new RegExp(`^可启动\\s*${ready}$`),
    new RegExp(`^冷却中\\s*${cooling}$`), new RegExp(`^待完善\\s*${incomplete}$`)
  ]);
}
function tempData(prefix) {
  fs.mkdirSync(path.join(root, 'test-results'), { recursive: true });
  return fs.mkdtempSync(path.join(root, 'test-results', prefix));
}
async function launch(dir, production = false) {
  const env = { ...process.env, N7M_TEST_DATA_DIR: dir }; delete env.ELECTRON_RUN_AS_NODE;
  const packaged = process.env.N7M_PACKAGED_TEST === '1';
  let entry = root;
  if (production && !packaged) {
    entry = path.join(dir, 'production-bootstrap.cjs');
    fs.writeFileSync(entry, `const { app } = require('electron'); Object.defineProperty(app, 'isPackaged', { value: true }); require(${JSON.stringify(path.join(root, 'electron/main.cjs'))});`);
  }
  const packagedDir = process.env.N7M_PACKAGED_DIR ? path.resolve(process.env.N7M_PACKAGED_DIR) : path.join(root, 'release', 'win-unpacked');
  app = await electron.launch({ args: packaged ? [] : [entry], ...(packaged ? { executablePath: path.join(packagedDir, 'N7M - Custom Email Management.exe') } : {}), env, timeout: 30000 });
  page = await app.firstWindow();
}
async function setup() {
  await page.getByLabel('软件密码', { exact: true }).fill(MASTER);
  await page.getByLabel('确认软件密码', { exact: true }).fill(MASTER);
  await page.getByRole('button', { name: '设置密码并解锁', exact: true }).click();
  await expect(page.getByRole('heading', { name: '账号管理', exact: true })).toBeVisible();
}
async function unlock(password = MASTER) {
  await page.getByLabel('软件密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '解锁', exact: true }).click();
  await expect(page.getByRole('heading', { name: '账号管理', exact: true })).toBeVisible();
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
  test.setTimeout(120000);
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
  await expect(page.locator('.sidebar')).toHaveCount(0); await expect(page.locator('.stats')).toHaveCount(0);
  for (const name of ['账号分组', '冷却设置', '批量启动页设定', '导入资料', '添加账号', '打开快捷栏']) await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
  await expect(page.locator('.accounts-table th').filter({ hasText: '启动网页' })).toHaveCount(0);
  // File import keeps missing browser and ID blank, while displaying an enabled launch action.
  await page.getByRole('button', { name: '导入资料', exact: true }).click();
  const csv = '邮箱链接,浏览器,Profile,编号,启动网页,备注,分组,标签\na@example.com,,,,,"first, line\nsecond",工作,常用\nA@example.com,Chrome,,999,https://example.com,,,\nb@example.com,Edge,,003,,项目邮箱,项目,常用';
  await page.locator('input[type=file]').setInputFiles({ name: 'accounts.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await expect(page.locator('.preview-summary')).toContainText('2 个可导入');
  await expect(page.locator('.preview-summary')).toContainText('1 个重复');
  await page.getByRole('button', { name: '确认导入 2 个', exact: true }).click();
  await expect(rowFor('a@example.com')).toContainText('未填写');
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
  await page.getByRole('button', { name: '批量编辑', exact: true }).click();
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
  // Stub just the browser adapter; production args have dedicated unit coverage.
  await app.evaluate(({ app }) => {
    const requireFromApp = process.getBuiltinModule('module').createRequire(`${app.getAppPath()}/package.json`);
    const launcher = requireFromApp('./electron/browser-launch.cjs');
    global.__n7mLaunches = [];
    launcher.launch = async entry => { global.__n7mLaunches.push({ browser: entry.browser, launchUrl: entry.launchUrl, profile: entry.profile }); };
  });
  await rowFor('a@example.com').getByRole('button', { name: '启动', exact: true }).click();
  await expect(rowFor('a@example.com')).toContainText('冷却中');
  await expectCounts(4, 3, 1, 0);
  expect(await app.evaluate(() => global.__n7mLaunches)).toEqual([{ browser: '系统默认', launchUrl: '', profile: '' }]);
  // Export excludes credentials and uses custom IDs / current status.
  const exportPath = path.join(dataDir, 'export.csv');
  await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, exportPath);
  await page.getByRole('button', { name: '导出资料', exact: true }).click();
  await expect.poll(() => fs.existsSync(exportPath)).toBe(true);
  const exported = fs.readFileSync(exportPath, 'utf8');
  expect(exported).toContain('"002","a@example.com"'); expect(exported).toContain('"已使用"');
  expect(exported).not.toContain(ACCOUNT_PASSWORD.trim()); expect(exported).not.toContain(TOTP_SECRET);
  await page.getByRole('button', { name: '打开快捷栏', exact: true }).click();
  await expect.poll(() => app.windows().length).toBe(2);
  const toolbar = app.windows().find(win => win !== page);
  await expect(toolbar.locator('.quick-card')).toHaveCount(3);
  await rowFor('a@example.com').getByTitle('撤销使用，恢复可用', { exact: true }).click();
  await expect(toolbar.locator('.quick-card')).toHaveCount(4);
  await expectCounts(4, 4, 0, 0);
  const fontSize = await page.locator('.accounts-table tbody td').first().evaluate(el => parseFloat(getComputedStyle(el).fontSize));
  expect(fontSize).toBeGreaterThanOrEqual(14);
  if (await page.getByRole('button', { name: '关闭提示', exact: true }).count()) await page.getByRole('button', { name: '关闭提示', exact: true }).click();
  await page.screenshot({ path: path.join(root, 'release', 'N7M-1.3.0-preview.png'), fullPage: true });
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
  for (const [browser, address] of [['Chrome', 'chrome://version'], ['Edge', 'edge://version'], ['Brave', 'brave://version']]) {
    await page.getByRole('button', { name: `${browser} · ${address}`, exact: true }).click();
    expect(await clipboardText()).toBe(address);
  }
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
  await expect(page.getByLabel('浏览器排序', { exact: true })).toHaveValue('original');
  expect(await rowEmails()).toEqual(seeded.map(entry => entry.email));
  await page.getByLabel('浏览器排序', { exact: true }).selectOption('browser-asc');
  const ascending = await rowEmails();
  expect(ascending).toEqual(['brave@example.com', 'chrome-first@example.com', 'chrome-second@example.com', 'edge@example.com', 'default@example.com', 'missing-browser@example.com']);
  expect(ascending.at(-1)).toBe('missing-browser@example.com');
  expect(ascending.indexOf('chrome-second@example.com')).toBe(ascending.indexOf('chrome-first@example.com') + 1);
  expect(groupOrder(ascending)).toHaveLength(4);
  await page.getByLabel('浏览器排序', { exact: true }).selectOption('browser-desc');
  const descending = await rowEmails();
  expect(descending).toEqual(['default@example.com', 'edge@example.com', 'chrome-first@example.com', 'chrome-second@example.com', 'brave@example.com', 'missing-browser@example.com']);
  expect(descending.at(-1)).toBe('missing-browser@example.com');
  expect(descending.indexOf('chrome-second@example.com')).toBe(descending.indexOf('chrome-first@example.com') + 1);
  expect(groupOrder(descending)).toEqual(groupOrder(ascending).reverse());
  await page.getByLabel('浏览器排序', { exact: true }).selectOption('original');
  await page.getByRole('button', { name: '按浏览器类型排序', exact: true }).click();
  await expect(page.getByLabel('浏览器排序', { exact: true })).toHaveValue('browser-asc');
  await page.getByRole('button', { name: '按浏览器类型排序', exact: true }).click();
  await expect(page.getByLabel('浏览器排序', { exact: true })).toHaveValue('browser-desc');
  await page.getByRole('button', { name: '按浏览器类型排序', exact: true }).click();
  await expect(page.getByLabel('浏览器排序', { exact: true })).toHaveValue('original');
  expect(await rowEmails()).toEqual(seeded.map(entry => entry.email));
  // A persistent empty group can be added directly from the dropdown.
  let menu = await groupMenu();
  await expect(menu).toBeVisible(); await expect(page.locator('.modal-shade')).toHaveCount(0);
  const menuFitsWindow = await menu.evaluate(el => { const bounds = el.getBoundingClientRect(); return bounds.left >= 0 && bounds.top >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight; });
  expect(menuFitsWindow).toBe(true);
  await menu.getByLabel('新分组名称', { exact: true }).fill('待处理');
  await menu.getByRole('button', { name: '添加分组', exact: true }).click();
  await expect(menu.getByRole('button', { name: '筛选分组 待处理', exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(root, 'release', 'N7M-1.3.0-groups.png'), fullPage: true });
  // The dropdown must remain reachable when the top controls wrap in a narrower window.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1000, 680));
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(1000);
  const narrowMenuFits = await menu.evaluate(el => { const bounds = el.getBoundingClientRect(); return bounds.left >= 0 && bounds.top >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight; });
  expect(narrowMenuFits).toBe(true);
  await expect(page.locator('.security-controls').getByRole('button', { name: '清空全部账号', exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(root, 'release', 'N7M-1.3.0-narrow.png'), fullPage: true });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1500, 900));
  let snapshot = await page.evaluate(() => window.emailManager.loadEmailData());
  expect(snapshot.data.groups).toContain('待处理');
  await page.getByRole('heading', { name: '账号管理', exact: true }).click();
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
  await page.getByRole('heading', { name: '账号管理', exact: true }).click();
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
    window.emailManager.importExcelFile('locked-import', new Uint8Array([80, 75]))
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

test.afterEach(async () => { if (app) { await app.close(); app = null; } });
