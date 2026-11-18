const { shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const execute = promisify(execFile);
const FIREFOX_INI_LIMIT = 1024 * 1024;
function firefoxProfileNames(input) {
  const source = String(input).replace(/^\uFEFF/, '');
  if (Buffer.byteLength(source, 'utf8') > FIREFOX_INI_LIMIT || /[\x00\ufffd]/.test(source)) throw new Error('Firefox 配置清单格式无效，请先在 Firefox 中检查配置');
  const sections = new Map(); let current = null;
  for (const raw of source.split(/\r?\n/)) {
    // Mozilla strips line-leading whitespace only. Trimming a Name value would
    // falsely validate a different -P target and could open the profile picker.
    const line = raw.replace(/^[ \t]+/, '');
    if (!line.trim() || /^[;#]/.test(line)) continue;
    if (line.startsWith('[')) {
      const header = /^\[(Profile\d+)\]$/.exec(line);
      current = null;
      if (header) {
        if (sections.has(header[1])) throw new Error('Firefox 配置清单存在重复项目，请先在 Firefox 中检查配置');
        current = { values: Object.create(null), invalid: false }; sections.set(header[1], current);
      }
      continue;
    }
    if (!current) continue;
    const separator = line.indexOf('=');
    if (separator < 1) { current.invalid = true; continue; }
    const key = line.slice(0, separator), value = line.slice(separator + 1);
    if (!['Name', 'Path', 'IsRelative'].includes(key)) continue;
    if (Object.hasOwn(current.values, key)) current.invalid = true;
    current.values[key] = value;
  }
  const names = [];
  // Mozilla reads Profile0, Profile1, ... until IsRelative is missing. Do not
  // accept a name from a later orphan section which Firefox itself ignores.
  for (let index = 0; ; index++) {
    const section = sections.get(`Profile${index}`);
    if (!section || !Object.hasOwn(section.values, 'IsRelative')) break;
    const { Name, Path, IsRelative } = section.values;
    if (!section.invalid && Name && Path && ['0', '1'].includes(IsRelative)) names.push(Name);
  }
  return names;
}
function ensureFirefoxProfileExists(value, { appData = process.env.APPDATA, readFile = fs.readFileSync, statFile = fs.statSync } = {}) {
  const profile = String(value || '').trim();
  if (!profile) return;
  browserArgs({ browser: 'Firefox', profile }, '');
  let names;
  try {
    if (!appData || !path.isAbsolute(appData)) throw new Error();
    const file = path.join(appData, 'Mozilla', 'Firefox', 'profiles.ini');
    const stat = statFile(file);
    if (!stat.isFile() || stat.size > FIREFOX_INI_LIMIT) throw new Error();
    names = firefoxProfileNames(readFile(file, 'utf8'));
  } catch { throw new Error('无法读取 Firefox 配置清单，请先在 Firefox 的 about:profiles 中创建并确认配置，或留空使用默认配置'); }
  const matches = names.filter(name => name === profile);
  if (matches.length !== 1) throw new Error(matches.length ? 'Firefox 中有重名配置，请先改为唯一名称后重试' : '未找到指定的 Firefox 配置，请复制 about:profiles 中的配置名称（区分大小写），不要填写目录路径');
}
function browserArgs(entry, url) {
  if (entry.browser === 'Firefox') {
    const profile = String(entry.profile || '').trim();
    if (profile && (profile.length > 128 || /^-/.test(profile) || /^[.]{1,2}$/.test(profile) || /[\x00-\x1f\x7f"\\/<>:|?*]/.test(profile))) throw new Error('Firefox Profile 名称无效，请填写 about:profiles 中的名称，而非完整路径');
    // --new-instance prevents a different running profile from receiving the
    // launch. Unlike the obsolete --no-remote it is supported by current Firefox.
    return [...(profile ? ['--new-instance', '-P', profile] : []), '--new-window', url || 'about:blank'];
  }
  if (entry.profile && !/^[a-z\d _+-]+$/i.test(entry.profile)) throw new Error('Profile 只支持字母、数字、空格、加号、下划线和连字符');
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
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', reject); child.once('spawn', () => { const pid = child.pid; child.unref(); resolve({ executable, pid }); });
  });
}
function defaultBrowserArgs(executable, url) {
  const file = path.win32.basename(executable).toLowerCase();
  if (file === 'firefox.exe') return browserArgs({ browser: 'Firefox', profile: '' }, url);
  const managed = ['chrome.exe', 'msedge.exe', 'brave.exe'].includes(file);
  return [...(managed ? ['--new-window'] : []), ...(url ? [url] : [])];
}
async function launch(entry, model, ensureUnlocked = () => {}) {
  const url = model.webUrl(entry.launchUrl);
  ensureUnlocked();
  if (entry.browser === '系统默认') {
    let executable;
    try { executable = await defaultBrowserExecutable(); }
    catch {
      // Registry discovery is asynchronous; a lock must also cancel fallback.
      ensureUnlocked();
      if (url) { await shell.openExternal(url); return { executable: null }; }
      throw new Error('无法找到系统默认浏览器，请手动选择 Chrome、Edge、Brave 或 Firefox');
    }
    ensureUnlocked();
    return spawnBrowser(executable, defaultBrowserArgs(executable, url));
  }
  const browsers = {
    Chrome: ['Google', 'Chrome', 'Application', 'chrome.exe'],
    Edge: ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
    Brave: ['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'],
    Firefox: ['Mozilla Firefox', 'firefox.exe']
  };
  if (!browsers[entry.browser]) throw new Error('请先设置浏览器类型');
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA];
  const executable = roots
    .filter(Boolean).map(root => path.join(root, ...browsers[entry.browser])).find(file => fs.existsSync(file));
  if (!executable) throw new Error(`未找到 ${entry.browser}，请确认已安装，或手动选择系统默认`);
  const args = browserArgs(entry, url);
  if (entry.browser === 'Firefox') ensureFirefoxProfileExists(entry.profile);
  ensureUnlocked();
  return spawnBrowser(executable, args);
}
module.exports = { launch, browserArgs, defaultBrowserArgs, defaultBrowserExecutable, commandExecutable, firefoxProfileNames, ensureFirefoxProfileExists };
