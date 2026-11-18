'use strict';
// Windows are identified individually, never by browser process alone: Chromium
// commonly hosts several Profiles in the same process. No title/URL is read.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const LIMIT = 4096;
const BROWSER_FILES = new Set(['chrome.exe', 'msedge.exe', 'brave.exe', 'firefox.exe']);
const ERROR = '无法读取浏览器窗口，请稍后重试';
function normalizeWindow(value, tagged = false) {
  if (!value || typeof value !== 'object' || typeof value.hwnd !== 'string' || !/^[1-9]\d{0,19}$/.test(value.hwnd) || BigInt(value.hwnd) > 0x7fffffffffffffffn ||
    !Number.isSafeInteger(value.pid) || value.pid <= 0 || value.pid > 0xffffffff ||
    typeof value.processStartedAt !== 'string' || !/^[1-9]\d{0,18}$/.test(value.processStartedAt) ||
    typeof value.executable !== 'string' || value.executable.length > 32767 || !path.win32.isAbsolute(value.executable) ||
    !BROWSER_FILES.has(path.win32.basename(value.executable).toLowerCase())) throw new Error('浏览器窗口标识无效');
  if (tagged && (typeof value.token !== 'string' || !/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(value.token))) throw new Error('浏览器窗口标记无效');
  return { hwnd: value.hwnd, pid: value.pid, processStartedAt: value.processStartedAt,
    executable: path.win32.normalize(value.executable),
    ...(typeof value.appId === 'string' && value.appId.length <= 512 ? { appId: value.appId } : {}),
    ...(typeof value.profile === 'string' && /^[a-z\d _+-]{1,128}$/i.test(value.profile) ? { profile: value.profile } : {}),
    ...(tagged ? { token: value.token.toLowerCase() } : {}) };
}
function windowKey(value) {
  const record = normalizeWindow(value);
  return `${record.hwnd}:${record.pid}:${record.processStartedAt}:${record.executable.toLowerCase()}`;
}
function newWindows(before, after, executable) {
  if (typeof executable !== 'string' || !path.win32.isAbsolute(executable)) return [];
  const expected = path.win32.normalize(executable).toLowerCase();
  const previous = new Set(before.map(windowKey));
  return after.map(value => normalizeWindow(value)).filter(value => value.executable.toLowerCase() === expected && !previous.has(windowKey(value)));
}
function createBrowserWindows({ platform = process.platform, execute, timeoutMs = 8000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 15000) throw new Error('浏览器窗口读取超时设置无效');
  const nativeExecute = execute || ((request) => new Promise((resolve, reject) => {
    const file = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    // Passing source through stdin works inside a packaged ASAR and avoids a
    // generated helper executable or shell-built command containing user text.
    const script = fs.readFileSync(path.join(__dirname, 'browser-windows.ps1'), 'utf8');
    const child = execFile(file, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', '[Console]::InputEncoding = [Text.UTF8Encoding]::new($false); $envelope = [Console]::In.ReadToEnd() | ConvertFrom-Json; & ([ScriptBlock]::Create([string]$envelope.source)) $envelope.request'], {
      windowsHide: true, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024,
      encoding: 'utf8'
    }, (error, stdout) => {
      if (error) return reject(new Error(ERROR));
      try { const result = JSON.parse(stdout.replace(/^\uFEFF/, '').trim()); if (!result || result.ok !== true) throw new Error(); resolve(result); }
      catch { reject(new Error(ERROR)); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ source: script, request }));
  }));
  const request = async (action, records = []) => {
    if (platform !== 'win32') throw new Error('自动检测和关闭浏览器窗口目前仅支持 Windows');
    if (!Array.isArray(records) || records.length > LIMIT) throw new Error('浏览器窗口数量超出限制');
    const result = await nativeExecute({ action, records });
    if (!result || result.ok !== true) throw new Error(ERROR);
    return result;
  };
  const recordsOf = input => {
    if (!Array.isArray(input) || input.length > LIMIT) throw new Error('浏览器窗口选择无效');
    const seen = new Set();
    return input.map(value => normalizeWindow(value, true)).filter(value => {
      const key = `${windowKey(value)}:${value.token}`; if (seen.has(key)) return false; seen.add(key); return true;
    });
  };
  async function snapshot() {
    const result = await request('snapshot');
    if (!Array.isArray(result.windows) || result.windows.length > LIMIT) throw new Error(ERROR);
    return result.windows.map(value => normalizeWindow(value));
  }
  async function tagWindow(value) {
    const candidate = normalizeWindow(value), token = crypto.randomUUID();
    const result = await request('tag', [{ ...candidate, token }]);
    if (!Array.isArray(result.results) || result.results.length !== 1 || result.results[0].state !== 'alive') throw new Error('浏览器窗口已改变，未能建立安全关联');
    return { ...candidate, token };
  }
  async function inspect(input) {
    const records = recordsOf(input);
    if (!records.length) return { alive: [], closed: [], unknown: [] };
    const result = await request('inspect', records);
    if (!Array.isArray(result.results) || result.results.length !== records.length) throw new Error(ERROR);
    const output = { alive: [], closed: [], unknown: [] };
    result.results.forEach((value, index) => {
      if (!['alive', 'closed', 'unknown'].includes(value.state)) throw new Error(ERROR);
      output[value.state].push(records[index]);
    });
    return output;
  }
  async function closeWindows(input) {
    const records = recordsOf(input);
    if (!records.length) return { requested: [], closed: [], remaining: [] };
    const result = await request('close', records);
    if (!Array.isArray(result.results) || result.results.length !== records.length) throw new Error(ERROR);
    const output = { requested: [], closed: [], remaining: [] };
    result.results.forEach((value, index) => {
      if (!['requested', 'closed', 'unknown', 'denied'].includes(value.state)) throw new Error(ERROR);
      output[value.state === 'unknown' || value.state === 'denied' ? 'remaining' : value.state].push(records[index]);
    });
    return output;
  }
  return { snapshot, tagWindow, inspect, closeWindows };
}
module.exports = { createBrowserWindows, normalizeWindow, windowKey, newWindows };
