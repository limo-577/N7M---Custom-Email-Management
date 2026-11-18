const { app, BrowserWindow, shell, ipcMain, dialog, clipboard, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { VaultStore } = require('./vault.cjs');
const { totp } = require('./totp.cjs');
const { EditSessions } = require('./edit-sessions.cjs');
const editSessions = new EditSessions();
const restoreSessions = new Map();
const sensitiveEpochs = new Map();
let sensitiveGlobalEpoch = 0;
const browserLauncher = require('./browser-launch.cjs');
const { createBrowserWindows, normalizeWindow, windowKey } = require('./browser-windows.cjs');
const { createBrowserController, matchesProfileIdentity } = require('./browser-controller.cjs');
const browserWindows = createBrowserWindows();
const browserController = createBrowserController({ adapter: browserWindows, launcher: browserLauncher });
const { trustedSender } = require('./security.cjs');
const { createXlsxImporter } = require('./xlsx-import.cjs');
const xlsxImporter = createXlsxImporter();
let activeImport = null;
const APP_NAME = 'N7M - Custom Email Management';
const backgroundTest = process.env.N7M_TEST_BACKGROUND === '1' && !!process.env.N7M_TEST_DATA_DIR;
// Preserve the established data directory after the product rename.
app.setPath('userData', process.env.N7M_TEST_DATA_DIR || path.join(app.getPath('appData'), 'email-manager'));
app.setName(APP_NAME);
const instanceLock = app.requestSingleInstanceLock();
if (!instanceLock) app.quit();
const isDev = !app.isPackaged;
let mainWindow, toolbarWindow, model, mutations, vault;
let startupPromise;
let copiedCredential = '', clipboardTimer;
const opening = new Map();
let refreshJob = null, browserPoll;
let verifiedWindows = new Set();
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function recordKey(record) { try { return `${windowKey(record)}:${normalizeWindow(record, true).token}`; } catch { return ''; } }
function windows() { return [mainWindow, toolbarWindow].filter(win => win && !win.isDestroyed()); }
function revokeRestore(token) {
  const session = restoreSessions.get(token);
  if (!session) return;
  editSessions.revoke(session.baselineToken);
  for (const entry of session.state.entries) { entry.password = ''; entry.totpSecret = ''; }
  session.state.entries = []; restoreSessions.delete(token);
}
function clearSensitiveSessions(sender) {
  if (sender == null) sensitiveGlobalEpoch++;
  else sensitiveEpochs.set(sender, (sensitiveEpochs.get(sender) || 0) + 1);
  editSessions.clear(sender);
  for (const [token, session] of restoreSessions) if (sender == null || session.sender === sender) revokeRestore(token);
}
function sensitiveContext(event) { return { global: sensitiveGlobalEpoch, local: sensitiveEpochs.get(event.sender.id) || 0 }; }
function requireSensitiveContext(event, context) {
  if (context.global !== sensitiveGlobalEpoch || context.local !== (sensitiveEpochs.get(event.sender.id) || 0) || !trustedSender(event, windows(), isDev)) throw new Error('窗口或验证状态已变化，操作已取消，请重新验证');
}
function validateIds(ids, max = 1000) {
  if (!Array.isArray(ids) || !ids.length || ids.length > max || ids.some(id => typeof id !== 'string' || !id || id.length > 256) || new Set(ids).size !== ids.length) throw new Error(`请选择 1 至 ${max} 个账号`);
}
function protectBrowserChanges(current, patches) {
  const byId = new Map(current.entries.map(entry => [entry.id, entry]));
  for (const { id, patch } of patches) {
    const entry = byId.get(id);
    if (!entry) throw new Error('账号已删除，请重新载入');
    if (!['browser', 'profile'].some(key => Object.hasOwn(patch, key) && String(patch[key] ?? '').trim() !== entry[key])) continue;
    if (opening.has(id)) throw new Error('浏览器正在启动，请稍后修改浏览器资料');
    if (entry.browserWindow) throw new Error('请先关闭对应账号的浏览器，再修改浏览器 / Profile');
  }
}
function writeEncryptedBackup(file, text) {
  const temporary = `${file}.tmp-${crypto.randomBytes(8).toString('hex')}`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600); fs.writeFileSync(descriptor, text, 'utf8'); fs.fsyncSync(descriptor);
    fs.closeSync(descriptor); descriptor = undefined; fs.renameSync(temporary, file);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
function protectExportTarget(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('导出路径无效');
  const canonical = value => (fs.existsSync(value) ? fs.realpathSync(value) : path.resolve(value)).toLowerCase();
  const target = canonical(file);
  if ([vault.file, `${vault.file}.bak`, ...vault.legacyFiles].some(value => canonical(value) === target)) throw new Error('不能把导出文件覆盖到软件资料库，请选择其他文件名或目录');
}
function snapshot() {
  const data = vault.snapshot();
  const openedIds = data.entries.filter(entry => matchesProfileIdentity(entry) && verifiedWindows.has(recordKey(entry.browserWindow))).map(entry => entry.id);
  const opened = new Set(openedIds);
  return { ...data, openedIds, canCloseIds: openedIds,
    untrackedIds: data.entries.filter(entry => recordKey(entry.browserWindow) && !opened.has(entry.id)).map(entry => entry.id) };
}
async function prepareUnlocked() {
  const state = vault.requireUnlocked();
  const entries = model.numberMissingEntries(state.entries);
  if (entries !== state.entries) vault.save({ ...state, entries, revision: state.revision + 1 });
  return refreshBrowserWindows();
}
async function refreshBrowserWindows(generation = vault.generation) {
  vault.requireUnlocked(generation);
  if (refreshJob?.generation === generation) return refreshJob.promise;
  const job = { generation };
  job.promise = (async () => {
    const initial = vault.requireUnlocked(generation), records = [];
    for (const entry of initial.entries) if (matchesProfileIdentity(entry) && recordKey(entry.browserWindow)) records.push(entry.browserWindow);
    let observed = { alive: [], closed: [], unknown: [] };
    if (records.length) {
      try { observed = await browserWindows.inspect(records); }
      catch { observed.unknown = records; }
    }
    const current = vault.requireUnlocked(generation);
    const previousVerified = verifiedWindows, considered = new Set(records.map(recordKey));
    const currentKeys = new Set(current.entries.filter(entry => matchesProfileIdentity(entry)).map(entry => recordKey(entry.browserWindow)).filter(Boolean));
    // Preserve a newly tagged window created while an older inspection awaited
    // its native response. Only replace identities actually inspected here.
    verifiedWindows = new Set([...previousVerified].filter(key => currentKeys.has(key) && !considered.has(key)));
    for (const record of observed.alive) if (currentKeys.has(recordKey(record))) verifiedWindows.add(recordKey(record));
    const closed = new Set(observed.closed.map(recordKey));
    let changed = false;
    const entries = current.entries.map(entry => {
      const key = recordKey(entry.browserWindow);
      // Historical tags are not enough: the current account must still have a
      // verifiable Chromium target matching the recorded Profile and browser.
      // Revoke only our association, never close the historical OS window.
      const invalidIdentity = !!entry.browserWindow && !matchesProfileIdentity(entry);
      // A launch without a verified identity cannot prove that a window is
      // still open. Migrate old pending markers to a nonblocking warning;
      // never guess ownership or expire an actual record after unknown scans.
      const unassociated = !key && (entry.browserWindow || entry.browserTracking === 'unconfirmed');
      const oldRecord = !key && (unassociated || entry.openedAt || entry.usedAt || entry.status === 'used');
      if (!invalidIdentity && !oldRecord && (!key || !closed.has(key))) return entry;
      changed = true;
      const { browserWindow, browserTracking, browserTrackingReason, ...rest } = entry;
      return { ...rest, openedAt: null, status: 'available', usedAt: null,
        ...(invalidIdentity ? { browserTracking: 'unmanaged', browserTrackingReason: 'identity' }
          : unassociated ? { browserTracking: 'unmanaged', browserTrackingReason: 'legacy' } : {}) };
    });
    const verificationChanged = previousVerified.size !== verifiedWindows.size || [...previousVerified].some(key => !verifiedWindows.has(key));
    return changed ? persist({ ...current, entries, revision: current.revision + 1 }, generation) : verificationChanged ? broadcast() : snapshot();
  })();
  refreshJob = job;
  try { return await job.promise; } finally { if (refreshJob === job) refreshJob = null; }
}
function broadcast() {
  const data = snapshot();
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
  clearSensitiveSessions();
  vault?.lock(); opening.clear(); verifiedWindows.clear(); clearCredentialClipboard();
  // Reload discards editor fields and decrypted renderer memory even if its UI is stalled.
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  for (const win of windows()) win.webContents.send('vault-locked');
  if (toolbarWindow && !toolbarWindow.isDestroyed()) toolbarWindow.close();
  if (mainWindow && !mainWindow.isDestroyed()) {
    const win = mainWindow; win.hide();
    win.webContents.once('did-finish-load', () => { if (!win.isDestroyed() && !backgroundTest) win.show(); });
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
  if (current && !current.isDestroyed()) { if (!backgroundTest) { if (current.isMinimized()) current.restore(); current.show(); current.focus(); } return; }
  const win = new BrowserWindow({
    title: toolbar ? `${APP_NAME} · 快捷栏` : APP_NAME,
    width: toolbar ? 420 : 1500, height: toolbar ? 460 : 900,
    minWidth: toolbar ? 340 : 1000, minHeight: toolbar ? 180 : 640,
    backgroundColor: '#f5f7f5', autoHideMenuBar: true,
    show: !backgroundTest, skipTaskbar: backgroundTest,
    alwaysOnTop: toolbar && !backgroundTest, maximizable: !toolbar,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: !backgroundTest, preload: path.join(__dirname, 'preload.cjs') }
  });
  if (toolbar) toolbarWindow = win; else mainWindow = win;
  guardNavigation(win);
  win.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) clearSensitiveSessions(win.webContents.id); });
  win.webContents.once('destroyed', () => clearSensitiveSessions(win.webContents.id));
  if (isDev) win.loadURL(`http://127.0.0.1:5173${toolbar ? '?toolbar=1' : ''}`);
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { query: toolbar ? { toolbar: '1' } : {} });
  win.on('closed', () => { if (toolbar) toolbarWindow = null; else mainWindow = null; });
  return win;
}
handle('vault-status', () => vault.status(), { authenticated: false });
handle('vault-setup', async password => { await vault.setup(password); return { data: await prepareUnlocked(), ...vault.status() }; }, { authenticated: false });
handle('vault-unlock', async password => { await vault.unlock(password); return { data: await prepareUnlocked(), ...vault.status() }; }, { authenticated: false });
handle('vault-lock', () => { lockVault(); return {}; }, { authenticated: false });
handle('vault-change-password', async ({ currentPassword, newPassword }) => {
  await vault.changePassword(currentPassword, newPassword); clearSensitiveSessions();
  for (const win of windows()) win.webContents.send('sensitive-sessions-revoked');
  return { data: snapshot() };
});
handle('begin-bulk-edit', async ({ ids, password }, event, generation) => {
  validateIds(ids);
  const context = sensitiveContext(event);
  const entries = await vault.getEntriesForEditing(ids, password, generation);
  vault.requireUnlocked(generation);
  requireSensitiveContext(event, context);
  return { ...editSessions.create(entries, event.sender.id, generation), entries, revision: vault.requireUnlocked(generation).revision };
});
handle('revoke-bulk-edit', (token, event) => {
  if (editSessions.sessions.get(token)?.sender === event.sender.id) editSessions.revoke(token);
  return {};
});
handle('apply-bulk-edit', ({ token, patches }, event, generation) => {
  const current = vault.requireUnlocked(generation);
  editSessions.validate(token, patches, current.entries, event.sender.id, generation);
  protectBrowserChanges(current, patches);
  if (!patches.length) { editSessions.revoke(token); return { data: snapshot() }; }
  const data = persist(mutations.applyMutation(current, { type: 'update-many', patches }), generation);
  editSessions.revoke(token); return { data };
});
handle('export-encrypted-backup', async ({ ids, password }, event, generation) => {
  if (ids != null) validateIds(ids, 100000);
  const context = sensitiveContext(event);
  const encrypted = await vault.createBackup(ids, password, generation);
  vault.requireUnlocked(generation);
  requireSensitiveContext(event, context);
  const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
    title: `${APP_NAME} · 导出加密完整备份`, defaultPath: `N7M-${new Date().toISOString().slice(0, 10)}.n7mbackup`,
    filters: [{ name: 'N7M 加密备份（包含密码和 TOTP）', extensions: ['n7mbackup'] }]
  });
  vault.requireUnlocked(generation);
  requireSensitiveContext(event, context);
  if (result.canceled) return { canceled: true };
  protectExportTarget(result.filePath);
  writeEncryptedBackup(result.filePath, encrypted); return { path: result.filePath };
});
handle('preview-backup', async ({ buffer, password, currentPassword }, event, generation) => {
  if (!(buffer instanceof Uint8Array) || buffer.byteLength > 64 * 1024 * 1024) throw new Error('备份文件无效或超过 64 MB');
  const context = sensitiveContext(event);
  await vault.reauthenticate(currentPassword === undefined ? password : currentPassword, generation);
  requireSensitiveContext(event, context);
  const state = await vault.readBackup(Buffer.from(buffer).toString('utf8'), password, generation);
  const current = vault.requireUnlocked(generation);
  requireSensitiveContext(event, context);
  for (const [oldToken, session] of restoreSessions) if (session.sender === event.sender.id) revokeRestore(oldToken);
  const token = crypto.randomBytes(32).toString('base64url'), expiresAt = Date.now() + 5 * 60000;
  const existing = new Map(current.entries.map(entry => [model.accountKey(entry), entry.id]));
  const membership = state.entries.map(entry => { const key = model.accountKey(entry); return [key, existing.get(key) || null]; });
  const ids = new Set(membership.map(([, id]) => id).filter(Boolean));
  const baseline = editSessions.create(current.entries.filter(entry => ids.has(entry.id)), event.sender.id, generation, { maxRows: 100000, maxCharacters: 40 * 1024 * 1024 });
  restoreSessions.set(token, { state, membership, baselineToken: baseline.token, expiresAt, sender: event.sender.id, generation });
  const existingCount = membership.filter(([, id]) => id != null).length;
  return { token, expiresAt, total: state.entries.length, existingCount, newCount: state.entries.length - existingCount, currentCount: current.entries.length };
});
handle('revoke-backup-preview', (token, event) => { if (restoreSessions.get(token)?.sender === event.sender.id) revokeRestore(token); return {}; });
handle('restore-backup', ({ token, policy, restoreSettings }, event, generation) => {
  const session = restoreSessions.get(token), current = vault.requireUnlocked(generation);
  if (!session || session.sender !== event.sender.id || session.generation !== generation || Date.now() >= session.expiresAt) { if (session?.sender === event.sender.id) revokeRestore(token); throw new Error('备份预览已过期，请重新检查备份'); }
  const existing = new Map(current.entries.map(entry => [model.accountKey(entry), entry.id]));
  if (session.membership.some(([key, id]) => (existing.get(key) || null) !== id)) throw new Error('账号列表已变化，请重新检查备份后确认');
  const result = mutations.restoreBackup(current, session.state, policy, restoreSettings === true);
  const original = new Map(current.entries.map(entry => [entry.id, entry]));
  const changed = result.state.entries.filter(entry => original.has(entry.id)).map(entry => ({ id: entry.id, patch: Object.fromEntries(mutations.EDITABLE_FIELDS.filter(key => JSON.stringify(original.get(entry.id)[key] ?? null) !== JSON.stringify(entry[key] ?? null)).map(key => [key, entry[key]])) })).filter(item => Object.keys(item.patch).length);
  editSessions.validate(session.baselineToken, changed, current.entries, event.sender.id, generation);
  protectBrowserChanges(current, result.state.entries.filter(entry => original.has(entry.id)).map(entry => ({ id: entry.id, patch: { browser: entry.browser, profile: entry.profile } })));
  const data = persist(result.state, generation); revokeRestore(token); return { data, counts: result.counts };
});
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
handle('load-email-data', () => ({ data: snapshot() }));
handle('refresh-browser-windows', async (_payload, _event, generation) => ({ data: await refreshBrowserWindows(generation) }));
handle('close-entry', async ({ id }, _event, generation) => {
  await refreshBrowserWindows(generation);
  const entry = vault.requireUnlocked(generation).entries.find(item => item.id === id);
  if (!entry) throw new Error('账号已删除');
  if (!entry.browserWindow) {
    if (entry.browserTracking === 'unmanaged') throw new Error('此记录未关联浏览器窗口，请在浏览器中手动关闭；软件未发送关闭请求');
    return { data: snapshot(), closed: true };
  }
  const key = recordKey(entry.browserWindow);
  if (!matchesProfileIdentity(entry) || !verifiedWindows.has(key)) throw new Error('窗口状态暂时无法确认，请刷新后重试；未向浏览器发送关闭请求');
  const result = await browserWindows.closeWindows([entry.browserWindow]);
  vault.requireUnlocked(generation);
  if (result.remaining.length) throw new Error('对应浏览器窗口暂时无法关闭，请检查是否以管理员身份运行浏览器');
  for (let attempt = 0; attempt < 4; attempt++) {
    await refreshBrowserWindows(generation);
    const latest = vault.requireUnlocked(generation).entries.find(item => item.id === id);
    if (!latest || recordKey(latest.browserWindow) !== key) return { data: snapshot(), closed: true };
    if (attempt < 3) await wait(200);
  }
  return { data: snapshot(), pending: true, message: '浏览器尚未关闭，请检查是否有下载或未保存内容的确认提示；关闭后状态会自动更新' };
});
handle('mark-entries-closed', ({ ids }, _event, generation) => {
  if (!Array.isArray(ids) || ids.length > 50000 || ids.some(id => typeof id !== 'string' || !id || id.length > 256)) throw new Error('账号选择无效');
  const selected = new Set(ids), current = vault.requireUnlocked(generation);
  const entries = current.entries.map(entry => selected.has(entry.id) && entry.openedAt ? { ...entry, openedAt: null } : entry);
  if (entries.every((entry, index) => entry === current.entries[index])) return { data: snapshot() };
  return { data: persist({ ...current, entries, revision: current.revision + 1 }, generation) };
});
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
handle('mutate-email-data', (operation, _event, generation) => {
  if (operation?.type === 'update-many') throw new Error('请通过批量修改界面验证软件密码后保存');
  if (operation?.type === 'update' && operation.ids?.length > 1 && ['password', 'totpSecret'].some(key => Object.hasOwn(operation.patch || {}, key))) throw new Error('批量修改密码或 TOTP 请先验证软件密码');
  const current = vault.requireUnlocked(generation), ids = new Set(operation.ids || []);
  if (['update', 'delete'].includes(operation.type)) {
    const changesBrowser = entry => operation.type === 'delete' || ['browser', 'profile'].some(key => Object.hasOwn(operation.patch || {}, key) && String(operation.patch[key] ?? '').trim() !== entry[key]);
    if (current.entries.some(entry => ids.has(entry.id) && opening.has(entry.id) && changesBrowser(entry))) throw new Error('浏览器正在启动，请等待启动完成后再修改浏览器资料或删除账号');
    if (current.entries.some(entry => ids.has(entry.id) && entry.browserWindow && changesBrowser(entry))) throw new Error('请先关闭对应账号的浏览器，再删除账号或修改浏览器 / Profile');
  }
  return { data: persist(mutations.applyMutation(current, operation), generation) };
});
handle('open-entry', async ({ id }, _event, generation) => {
  let current = vault.requireUnlocked(generation);
  await refreshBrowserWindows(generation);
  current = vault.requireUnlocked(generation);
  const entry = current.entries.find(entry => entry.id === id);
  if (!entry) throw new Error('账号已删除');
  if (opening.has(id)) throw new Error('浏览器正在启动，请稍候');
  if (entry.browserWindow) throw new Error('该账号的浏览器已经打开，请先关闭对应窗口');
  const issues = model.issuesOf(entry);
  if (issues.length) throw new Error(`请先编辑资料：${issues.join('、')}`);
  const token = Symbol(id);
  opening.set(id, token);
  try {
    const managed = await browserController.launch({ browser: entry.browser, profile: entry.profile, launchUrl: entry.launchUrl }, model, () => vault.requireUnlocked(generation));
    current = vault.requireUnlocked(generation);
    const latest = current.entries.find(item => item.id === id);
    if (!latest) throw new Error('账号已删除，启动记录未保存');
    if (latest.browser !== entry.browser || latest.profile !== entry.profile) throw new Error('浏览器资料已修改，启动记录未保存，请检查后重试');
    const record = recordKey(managed.record) ? managed.record : null;
    const openedAt = record ? Date.now() : null;
    if (record) verifiedWindows.add(recordKey(record));
    const reason = ['baseline', 'unsupported', 'identity', 'ambiguous', 'timeout', 'tag', 'scan'].includes(managed.reason) ? managed.reason : 'tag';
    return { data: persist({ ...current, revision: current.revision + 1,
      entries: current.entries.map(item => item.id === id ? { ...item, status: record ? 'used' : 'available', usedAt: openedAt, openedAt,
        browserWindow: record, browserTracking: record ? 'tracked' : 'unmanaged', browserTrackingReason: record ? null : reason } : item) }, generation), message: managed.warning };
  } finally { if (opening.get(id) === token) opening.delete(id); }
});
handle('copy-text', value => { clipboard.writeText(String(value)); return {}; });
handle('export-email-data', async ({ ids }, event, generation) => {
  const context = sensitiveContext(event);
  const current = vault.requireUnlocked(generation);
  const entries = ids ? current.entries.filter(entry => ids.includes(entry.id)) : current.entries;
  if (!entries.length) throw new Error('没有可导出的资料');
  const result = await dialog.showSaveDialog(mainWindow || toolbarWindow, {
    title: `${APP_NAME} · 导出资料（不含密码和 TOTP 密钥）`, defaultPath: `N7M-Custom-Email-Management-${new Date().toISOString().slice(0, 10)}.csv`,
    filters: [{ name: 'CSV 文件（不含密码和 TOTP 密钥）', extensions: ['csv'] }]
  });
  vault.requireUnlocked(generation);
  requireSensitiveContext(event, context);
  if (result.canceled) return { canceled: true };
  protectExportTarget(result.filePath);
  fs.writeFileSync(result.filePath, model.exportCsv(entries, current.settings), 'utf8');
  return { path: result.filePath };
});
handle('open-toolbar', () => { createWindow(true); return {}; });
handle('close-toolbar', () => { toolbarWindow?.close(); return {}; });
handle('set-toolbar-always-on-top', value => { toolbarWindow?.setAlwaysOnTop(Boolean(value)); return {}; });
handle('open-main-window', () => { createWindow(); return {}; }, { authenticated: false });
if (instanceLock) startupPromise = app.whenReady().then(async () => {
  [model, mutations] = await Promise.all([
    import(pathToFileURL(path.join(__dirname, '..', 'src', 'model.mjs')).href),
    import(pathToFileURL(path.join(__dirname, '..', 'src', 'mutations.mjs')).href),
  ]);
  vault = new VaultStore(app.getPath('userData'), model.normalizeState);
  const session = require('electron').session.defaultSession;
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  powerMonitor.on('lock-screen', lockVault);
  powerMonitor.on('suspend', lockVault);
  browserPoll = setInterval(() => {
    editSessions.sweep(); for (const [token, session] of restoreSessions) if (Date.now() >= session.expiresAt) revokeRestore(token);
    if (vault?.key) refreshBrowserWindows().catch(() => {});
  }, 4000);
  createWindow();
});
function revealMainWindow() {
  // A repeated click can arrive while the first process is still initializing.
  // Wait for the vault and IPC dependencies rather than opening a half-ready UI.
  if (vault) createWindow();
  else startupPromise?.then(() => createWindow()).catch(() => {});
}
startupPromise?.catch(error => {
  if (backgroundTest) process.stderr.write(`Background startup failed: ${error.message}\n`);
  else dialog.showErrorBox(APP_NAME, `启动未能完成，请重新打开软件。\n${error.message}`);
  app.quit();
});
app.on('second-instance', revealMainWindow);
app.on('activate', revealMainWindow);
app.on('before-quit', () => { clearInterval(browserPoll); clearSensitiveSessions(); xlsxImporter.dispose(); clearCredentialClipboard(); vault?.lock(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
