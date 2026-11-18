// All desktop checks stay invisible and isolated from the user's real vault,
// browsers and clipboard. Never launch the application before these guards.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const electron = require('electron');
const { app, dialog, clipboard } = electron;
process.on('uncaughtException', error => { process.stderr.write(`Background test startup failed: ${error.stack}\n`); app.exit(1); });
const root = process.env.N7M_BACKGROUND_APP_ROOT;
if (!root || !process.env.N7M_TEST_DATA_DIR) throw new Error('Background desktop tests require an isolated data directory');
app.setAppPath(root);
process.env.N7M_TEST_BACKGROUND = '1';
Object.defineProperty(app, 'isPackaged', { value: process.env.N7M_BACKGROUND_PRODUCTION === '1' });
dialog.showErrorBox = (_title, message) => { process.stderr.write(`Background application error: ${message}\n`); };
dialog.showSaveDialog = async () => ({ canceled: true });
dialog.showMessageBox = async () => ({ response: 0 });
global.__n7mClipboard = '';
clipboard.writeText = value => { global.__n7mClipboard = value; };
clipboard.readText = () => global.__n7mClipboard;
clipboard.clear = () => { global.__n7mClipboard = ''; };
// Fake only the external browser OS boundary. Persist these harmless window
// identities so restart tests model browsers outliving the manager process.
const windowModule = require(path.join(root, 'electron', 'browser-windows.cjs'));
const registryFile = path.join(process.env.N7M_TEST_DATA_DIR, 'fake-browser-windows.json');
let registry = fs.existsSync(registryFile) ? JSON.parse(fs.readFileSync(registryFile, 'utf8')) : [];
let nextWindow = Math.max(100, ...registry.map(record => Number(record.hwnd))) + 1;
function saveWindows() { fs.mkdirSync(path.dirname(registryFile), { recursive: true }); fs.writeFileSync(registryFile, JSON.stringify(registry)); }
global.__n7mExternalClose = hwnd => { registry = registry.filter(record => record.hwnd !== hwnd); saveWindows(); };
global.__n7mFakeWindows = () => registry.map(record => ({ ...record }));
global.__n7mSnapshotError = false;
global.__n7mNoNewWindow = false;
global.__n7mTagError = false;
global.__n7mCloseRequests = [];
const matches = (a, b) => windowModule.windowKey(a) === windowModule.windowKey(b) && a.token === b.token;
windowModule.createBrowserWindows = () => ({
  snapshot: async () => {
    if (global.__n7mSnapshotError) throw new Error('Synthetic window detection unavailable');
    return registry.map(record => ({ ...record }));
  },
  tagWindow: async candidate => {
    if (global.__n7mTagError) throw new Error('Synthetic window tagging unavailable');
    const actual = registry.find(record => windowModule.windowKey(record) === windowModule.windowKey(candidate));
    if (!actual) throw new Error('Window already closed');
    actual.token = crypto.randomUUID(); saveWindows(); return { ...actual };
  },
  inspect: async records => {
    if (global.__n7mInspectUnknown) return { alive: [], closed: [], unknown: records };
    return { alive: records.filter(record => registry.some(actual => matches(actual, record))),
      closed: records.filter(record => !registry.some(actual => matches(actual, record))), unknown: [] };
  },
  closeWindows: async records => {
    global.__n7mCloseRequests.push(...records.map(record => ({ ...record })));
    const requested = [], closed = [], remaining = [];
    for (const record of records) {
      if (!registry.some(actual => matches(actual, record))) closed.push(record);
      else if (global.__n7mCloseDenied) remaining.push(record);
      else { requested.push(record); if (!global.__n7mClosePending) global.__n7mExternalClose(record.hwnd); }
    }
    return { requested, closed, remaining };
  }
});
const launcher = require(path.join(root, 'electron', 'browser-launch.cjs'));
let fakeLaunch = async () => { throw new Error('Browser launch disabled in background tests'); };
Object.defineProperty(launcher, 'launch', { configurable: true,
  get: () => async entry => {
    await fakeLaunch(entry);
    const filename = entry.browser === 'Edge' ? 'msedge.exe' : entry.browser === 'Brave' ? 'brave.exe' : entry.browser === 'Firefox' ? 'firefox.exe' : 'chrome.exe';
    const executable = `C:\\N7M-Test-Browsers\\${filename}`;
    if (!global.__n7mNoNewWindow) {
      registry.push({ hwnd: String(nextWindow++), pid: 900001, processStartedAt: '638900000000000000', executable,
        profile: /^\d+$/.test(entry.profile) ? `Profile ${entry.profile}` : entry.profile || 'Default' });
      saveWindows();
    }
    return { executable, pid: 900001 };
  }, set: value => { fakeLaunch = value; }
});
require(path.join(root, 'electron', 'main.cjs'));
