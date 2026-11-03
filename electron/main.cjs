const { app, BrowserWindow, shell, ipcMain, dialog, clipboard, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { VaultStore } = require('./vault.cjs');
const { totp } = require('./totp.cjs');
const browserLauncher = require('./browser-launch.cjs');
const { trustedSender } = require('./security.cjs');
const { createXlsxImporter } = require('./xlsx-import.cjs');
const xlsxImporter = createXlsxImporter();
let activeImport = null;
const APP_NAME = 'N7M - Custom Email Management';
// Preserve the established data directory after the product rename.
app.setPath('userData', process.env.N7M_TEST_DATA_DIR || path.join(app.getPath('appData'), 'email-manager'));
app.setName(APP_NAME);
const instanceLock = app.requestSingleInstanceLock();
if (!instanceLock) app.quit();
const isDev = !app.isPackaged;
let mainWindow, toolbarWindow, model, mutations, vault;
let copiedCredential = '', clipboardTimer;
const opening = new Set();
function windows() { return [mainWindow, toolbarWindow].filter(win => win && !win.isDestroyed()); }
function broadcast() {
  const data = vault.snapshot();
  for (const win of windows()) win.webContents.send('email-data-updated', data);
  return data;
}
function persist(next, generation = vault.generation) { vault.save(next, generation); return broadcast(); }
function clearCredentialClipboard() {
  clearTimeout(clipboardTimer);
  if (copiedCredential && clipboard.readText() === copiedCredential) clipboard.clear();
  copiedCredential = '';
}
function lockVault() {
  xlsxImporter.cancel();
  vault?.lock(); opening.clear(); clearCredentialClipboard();
  // Reload discards editor fields and decrypted renderer memory even if its UI is stalled.
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  for (const win of windows()) win.webContents.send('vault-locked');
  if (toolbarWindow && !toolbarWindow.isDestroyed()) toolbarWindow.close();
  if (mainWindow && !mainWindow.isDestroyed()) {
    const win = mainWindow; win.hide();
    win.webContents.once('did-finish-load', () => { if (!win.isDestroyed()) win.show(); });
    win.webContents.reload();
  }
}
function handle(channel, action, { authenticated = true } = {}) {
  ipcMain.handle(channel, async (event, payload) => {
    if (!trustedSender(event, windows(), isDev)) return { ok: false, error: '无效窗口或页面' };
    try {
      const generation = vault?.generation;
      if (authenticated) vault.requireUnlocked(generation);
      const result = await action(payload, event, generation);
      if (authenticated) vault.requireUnlocked(generation);
      return { ok: true, ...result };
    } catch (error) { return { ok: false, error: error.message }; }
  });
}
function guardNavigation(win) {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => { if (url !== win.webContents.getURL()) event.preventDefault(); });
  win.webContents.on('will-frame-navigate', event => event.preventDefault());
  win.webContents.on('will-attach-webview', event => event.preventDefault());
}
function createWindow(toolbar = false) {
  const current = toolbar ? toolbarWindow : mainWindow;
  if (current && !current.isDestroyed()) { if (current.isMinimized()) current.restore(); current.show(); current.focus(); return; }
  const win = new BrowserWindow({
    title: toolbar ? `${APP_NAME} · 快捷栏` : APP_NAME,
    width: toolbar ? 420 : 1500, height: toolbar ? 460 : 900,
    minWidth: toolbar ? 340 : 1000, minHeight: toolbar ? 180 : 640,
    backgroundColor: '#f5f7f5', autoHideMenuBar: true,
    alwaysOnTop: toolbar, maximizable: !toolbar,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: path.join(__dirname, 'preload.cjs') }
  });
  if (toolbar) toolbarWindow = win; else mainWindow = win;
  guardNavigation(win);
  if (isDev) win.loadURL(`http://127.0.0.1:5173${toolbar ? '?toolbar=1' : ''}`);
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { query: toolbar ? { toolbar: '1' } : {} });
  win.on('closed', () => { if (toolbar) toolbarWindow = null; else mainWindow = null; });
  return win;
}
handle('vault-status', () => vault.status(), { authenticated: false });
handle('vault-setup', async password => ({ data: await vault.setup(password), ...vault.status() }), { authenticated: false });
handle('vault-unlock', async password => ({ data: await vault.unlock(password), ...vault.status() }), { authenticated: false });
handle('vault-lock', () => { lockVault(); return {}; }, { authenticated: false });
handle('vault-change-password', async ({ currentPassword, newPassword }) => ({ data: await vault.changePassword(currentPassword, newPassword) }));
handle('read-entry-secrets', ({ id }) => {
  const entry = vault.requireUnlocked().entries.find(entry => entry.id === id);
  if (!entry) throw new Error('账号已删除');
  return { password: entry.password || '', totpSecret: entry.totpSecret || '' };
});
handle('copy-credential', ({ id, field }) => {
  const entry = vault.requireUnlocked().entries.find(entry => entry.id === id);
  if (!entry) throw new Error('账号已删除');
  let value;
  if (field === 'password') { value = entry.password; if (!value) throw new Error('请先在编辑中设置邮箱密码'); }
  else if (field === 'totp') value = totp(model.normalizeTotpSecret(entry.totpSecret || ''));
  else throw new Error('不支持的凭据类型');
  clearCredentialClipboard(); copiedCredential = value; clipboard.writeText(value);
  clipboardTimer = setTimeout(clearCredentialClipboard, 30000); clipboardTimer.unref();
  return {};
});
handle('load-email-data', () => ({ data: vault.snapshot() }));
handle('import-excel-file', async ({ requestId, buffer }, event, generation) => {
  if (typeof requestId !== 'string' || !/^[a-z\d-]{1,64}$/i.test(requestId)) throw new Error('导入请求无效');
  if (activeImport) throw new Error('正在读取 Excel，请等待或取消当前导入');
  const job = { sender: event.sender, requestId };
  activeImport = job;
  const cancel = () => { if (activeImport === job) xlsxImporter.cancel(); };
  event.sender.once('destroyed', cancel);
  // Navigation/reload must discard both the pending response and its worker.
  const navigate = (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) cancel(); };
  event.sender.on('did-start-navigation', navigate);
  try {
    job.pending = xlsxImporter.parse(buffer);
    const sheets = await job.pending;
    vault.requireUnlocked(generation);
    return { sheets };
  } finally {
    event.sender.removeListener('destroyed', cancel);
    event.sender.removeListener('did-start-navigation', navigate);
    if (activeImport === job) activeImport = null;
  }
});
handle('cancel-excel-import', async (requestId, event) => {
  const job = activeImport;
  if (job?.sender === event.sender && job.requestId === requestId) {
    xlsxImporter.cancel();
    await job.pending?.catch(() => {});
  }
  return {};
});
handle('mutate-email-data', (operation, _event, generation) => ({ data: persist(mutations.applyMutation(vault.requireUnlocked(generation), operation), generation) }));
handle('open-entry', async ({ id }, _event, generation) => {
  let current = vault.requireUnlocked(generation);
  const entry = current.entries.find(entry => entry.id === id);
  if (!entry) throw new Error('账号已删除');
  if (opening.has(id) || model.effectiveStatus(entry, current.settings) === 'used') throw new Error('账号正在冷却中');
  const issues = model.issuesOf(entry);
  if (issues.length) throw new Error(`请先编辑资料：${issues.join('、')}`);
  opening.add(id);
  try {
    await browserLauncher.launch(entry, model, () => vault.requireUnlocked(generation));
    current = vault.requireUnlocked(generation);
    return { data: persist({ ...current, revision: current.revision + 1,
      entries: current.entries.map(item => item.id === id ? { ...item, status: 'used', usedAt: Date.now() } : item) }, generation) };
  } finally { opening.delete(id); }
});
handle('copy-text', value => { clipboard.writeText(String(value)); return {}; });
handle('export-email-data', async ({ ids }, _event, generation) => {
  const current = vault.requireUnlocked(generation);
  const entries = ids ? current.entries.filter(entry => ids.includes(entry.id)) : current.entries;
  if (!entries.length) throw new Error('没有可导出的资料');
  const result = await dialog.showSaveDialog(mainWindow || toolbarWindow, {
    title: `${APP_NAME} · 导出资料（不含密码和 TOTP 密钥）`, defaultPath: `N7M-Custom-Email-Management-${new Date().toISOString().slice(0, 10)}.csv`,
    filters: [{ name: 'CSV 文件（不含密码和 TOTP 密钥）', extensions: ['csv'] }]
  });
  vault.requireUnlocked(generation);
  if (result.canceled) return { canceled: true };
  fs.writeFileSync(result.filePath, model.exportCsv(entries, current.settings), 'utf8');
  return { path: result.filePath };
});
handle('open-toolbar', () => { createWindow(true); return {}; });
handle('close-toolbar', () => { toolbarWindow?.close(); return {}; });
handle('set-toolbar-always-on-top', value => { toolbarWindow?.setAlwaysOnTop(Boolean(value)); return {}; });
handle('open-main-window', () => { createWindow(); return {}; }, { authenticated: false });
if (instanceLock) app.whenReady().then(async () => {
  model = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'model.mjs')).href);
  mutations = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'mutations.mjs')).href);
  vault = new VaultStore(app.getPath('userData'), model.normalizeState);
  const session = require('electron').session.defaultSession;
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  powerMonitor.on('lock-screen', lockVault);
  powerMonitor.on('suspend', lockVault);
  createWindow();
});
app.on('second-instance', () => { if (model) createWindow(); });
app.on('activate', () => { if (model) createWindow(); });
app.on('before-quit', () => { xlsxImporter.dispose(); clearCredentialClipboard(); vault?.lock(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
