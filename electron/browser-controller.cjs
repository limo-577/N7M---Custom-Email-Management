'use strict';
const path = require('path');
const { newWindows, windowKey } = require('./browser-windows.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const SUPPORTED_EXECUTABLES = new Set(['chrome.exe', 'msedge.exe', 'brave.exe', 'firefox.exe']);
const WARNINGS = {
  baseline: '启动前的窗口检测不可用，可手动使用并关闭浏览器',
  unsupported: '此浏览器暂不支持窗口管理，请选择 Chrome、Edge、Brave 或 Firefox',
  identity: '没有可验证的目标 Profile，软件只启动浏览器，不关联或自动关闭窗口',
  ambiguous: '检测到多个可能的新窗口，为避免误关其他账号，未建立关联',
  timeout: '检测时间内未找到稳定的新窗口，如浏览器仍在加载，可稍后重试',
  tag: '无法为对应新窗口建立安全标记，可手动使用并关闭浏览器',
  scan: '启动后的窗口检测暂不可用，请检查权限后重试'
};
const unassociated = reason => ({ record: null, warning: `浏览器已启动，但未能安全识别窗口：${WARNINGS[reason]}`, reason });
const supportedExecutable = executable => typeof executable === 'string' && path.win32.isAbsolute(executable) && SUPPORTED_EXECUTABLES.has(path.win32.basename(executable).toLowerCase());
const CHROMIUM_EXECUTABLES = { Chrome: 'chrome.exe', Edge: 'msedge.exe', Brave: 'brave.exe' };
function targetProfileOf(entry) {
  if (!Object.hasOwn(CHROMIUM_EXECUTABLES, entry?.browser) || typeof entry.profile !== 'string' || !entry.profile) return '';
  return (/^\d+$/.test(entry.profile) ? `Profile ${entry.profile}` : entry.profile).toLowerCase();
}
function matchesProfileIdentity(entry, record = entry?.browserWindow) {
  const expected = targetProfileOf(entry);
  return !!expected && typeof record?.profile === 'string' && !!record.profile && record.profile.toLowerCase() === expected &&
    typeof record.executable === 'string' && path.win32.isAbsolute(record.executable) &&
    path.win32.basename(record.executable).toLowerCase() === CHROMIUM_EXECUTABLES[entry.browser];
}
function createBrowserController({ adapter, launcher, wait = pause, discoveryAttempts = 8 } = {}) {
  let queue = Promise.resolve();
  function serialize(action) {
    const pending = queue.then(action, action);
    queue = pending.catch(() => {});
    return pending;
  }
  async function launch(entry, model, ensureUnlocked = () => {}) {
    return serialize(async () => {
      ensureUnlocked();
      let before;
      try { before = await adapter.snapshot(); if (!Array.isArray(before)) before = null; } catch { before = null; }
      ensureUnlocked();
      const started = await launcher.launch(entry, model, ensureUnlocked);
      ensureUnlocked();
      if (!supportedExecutable(started?.executable)) return unassociated('unsupported');
      if (!before) return unassociated('baseline');
      const expectedProfile = targetProfileOf(entry);
      // A stable new HWND alone cannot establish that it belongs to this
      // launch. Firefox/default routing and an omitted Chromium Profile do not
      // expose a verifiable target profile; keep their normal launch behavior
      // without granting the application authority to close a guessed window.
      if (!expectedProfile) return unassociated('identity');
      let stableCandidate = null, retryCandidateKey = '', tagAttempts = 0;
      for (let attempt = 0; attempt < discoveryAttempts; attempt++) {
        ensureUnlocked();
        let after;
        try { after = await adapter.snapshot(); } catch { ensureUnlocked(); return unassociated('scan'); }
        ensureUnlocked();
        let candidates;
        try { candidates = newWindows(before, after, started.executable).filter(record => matchesProfileIdentity(entry, record)); }
        catch { return unassociated('scan'); }
        // An unrelated concurrent window cannot be safely chosen from several
        // candidates. Never infer ownership from a shared Chromium process.
        if (candidates.length > 1) return unassociated('ambiguous');
        // A failed tag may be transient, but the retry must still refer to the
        // exact same new window. Never switch to a replacement or another Profile.
        if (retryCandidateKey && (candidates.length !== 1 || windowKey(candidates[0]) !== retryCandidateKey)) return unassociated('tag');
        if (candidates.length === 1) {
          const candidate = candidates[0];
          if (stableCandidate && windowKey(stableCandidate) === windowKey(candidate)) {
            tagAttempts++;
            let tagged;
            try { tagged = await adapter.tagWindow(candidate); if (!tagged) throw new Error('窗口标记无效'); }
            catch {
              ensureUnlocked();
              if (tagAttempts >= 2) return unassociated('tag');
              retryCandidateKey = windowKey(candidate);
            }
            ensureUnlocked();
            if (tagged) return { record: tagged, warning: '' };
          }
          stableCandidate = candidate;
        } else stableCandidate = null;
        if (attempt + 1 < discoveryAttempts) await wait(200);
      }
      return unassociated(retryCandidateKey ? 'tag' : 'timeout');
    });
  }
  return { launch };
}
module.exports = { createBrowserController, matchesProfileIdentity };
