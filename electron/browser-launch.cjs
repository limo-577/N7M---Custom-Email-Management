const { shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const execute = promisify(execFile);
function browserArgs(entry, url) {
  if (entry.profile && !/^[a-z\d _-]+$/i.test(entry.profile)) throw new Error('Profile 只支持字母、数字、空格、下划线和连字符');
  const profile = /^\d+$/.test(entry.profile) ? `Profile ${entry.profile}` : entry.profile;
  return [...(profile ? [`--profile-directory=${profile}`] : []), '--new-window', ...(url ? [url] : [])];
}
function commandExecutable(command) {
  const match = String(command).trim().match(/^"([^"]+\.exe)"|^(.+?\.exe)(?:\s|$)/i);
  if (!match) throw new Error('无法识别默认浏览器启动命令');
  const file = (match[1] || match[2]).replace(/%([^%]+)%/g, (_all, key) => process.env[key] || `%${key}%`);
  if (!path.isAbsolute(file) || !fs.existsSync(file)) throw new Error('找不到系统默认浏览器，请手动选择浏览器类型');
  return file;
}
async function defaultBrowserExecutable(query = execute) {
  const reg = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
  const options = { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 };
  try {
    const { stdout } = await query(reg, ['query', 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice', '/v', 'ProgId'], options);
    const progId = stdout.match(/ProgId\s+REG_SZ\s+(.+)$/im)?.[1].trim();
    if (!progId || !/^[a-z\d._-]+$/i.test(progId)) throw new Error('无法识别默认浏览器');
    const command = await query(reg, ['query', `HKCR\\${progId}\\shell\\open\\command`, '/ve'], options);
    return commandExecutable(command.stdout.match(/REG_(?:EXPAND_)?SZ\s+(.+)$/im)?.[1] || '');
  } catch {
    // A fresh Windows user may inherit the protocol handler without UserChoice.
    const inherited = await query(reg, ['query', 'HKCR\\https\\shell\\open\\command', '/ve'], options);
    return commandExecutable(inherited.stdout.match(/REG_(?:EXPAND_)?SZ\s+(.+)$/im)?.[1] || '');
  }
}
async function spawnBrowser(executable, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); });
  });
}
async function launch(entry, model, ensureUnlocked = () => {}) {
  const url = model.webUrl(entry.launchUrl);
  ensureUnlocked();
  if (entry.browser === '系统默认') {
    if (url) return shell.openExternal(url);
    let executable;
    try { executable = await defaultBrowserExecutable(); }
    catch { throw new Error('无法找到系统默认浏览器，请手动选择 Chrome、Edge 或 Brave'); }
    ensureUnlocked();
    return spawnBrowser(executable, []);
  }
  const browsers = {
    Chrome: ['Google', 'Chrome', 'Application', 'chrome.exe'],
    Edge: ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
    Brave: ['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe']
  };
  if (!browsers[entry.browser]) throw new Error('请先设置浏览器类型');
  const executable = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]
    .filter(Boolean).map(root => path.join(root, ...browsers[entry.browser])).find(file => fs.existsSync(file));
  if (!executable) throw new Error(`未找到 ${entry.browser}，请确认已安装，或手动选择系统默认`);
  ensureUnlocked();
  return spawnBrowser(executable, browserArgs(entry, url));
}
module.exports = { launch, browserArgs, defaultBrowserExecutable, commandExecutable };
