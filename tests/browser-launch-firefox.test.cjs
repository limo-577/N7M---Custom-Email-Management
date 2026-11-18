const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { browserArgs, defaultBrowserArgs, firefoxProfileNames, ensureFirefoxProfileExists } = require('../electron/browser-launch.cjs');

test('locking during failed default-browser discovery cancels the external URL fallback', async () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../electron/browser-launch.cjs'), 'utf8');
  const exports = { exports: {} }; let locked = false, opened = 0;
  const load = name => {
    if (name === 'electron') return { shell: { openExternal: async () => { opened++; } } };
    if (name === 'child_process') return { execFile: (_file, _args, _options, callback) => {
      queueMicrotask(() => { locked = true; callback(new Error('Registry unavailable')); });
    } };
    return require(name);
  };
  vm.runInNewContext('(function(require, module, process) {' + source + '\n})')(load, exports, process);
  const model = { webUrl: value => value };
  await assert.rejects(exports.exports.launch({ browser: '系统默认', launchUrl: 'https://example.com/' }, model,
    () => { if (locked) throw new Error('Vault locked'); }), /Vault locked/);
  assert.equal(opened, 0);
  locked = false;
  await exports.exports.launch({ browser: '系统默认', launchUrl: 'https://example.com/' }, model);
  assert.equal(opened, 1, 'unlocked fallback remains available');
});

test('Firefox uses case-sensitive named profiles with a new instance and never Chromium numeric directory rewriting', () => {
  assert.deepEqual(browserArgs({ browser: 'Firefox', profile: '工作 账号 (Mail)' }, ''), ['--new-instance', '-P', '工作 账号 (Mail)', '--new-window', 'about:blank']);
  assert.deepEqual(browserArgs({ browser: 'Firefox', profile: '43' }, 'https://example.com/'), ['--new-instance', '-P', '43', '--new-window', 'https://example.com/']);
  assert.deepEqual(browserArgs({ browser: 'Firefox', profile: 'Work.Profile' }, ''), ['--new-instance', '-P', 'Work.Profile', '--new-window', 'about:blank']);
  assert.deepEqual(browserArgs({ browser: 'Firefox', profile: '' }, ''), ['--new-window', 'about:blank']);
});

test('Firefox profile values reject paths, option-like names and control characters without exposing supplied values', () => {
  for (const profile of ['C:\\private-profile', '../private-profile', '--private-window', 'private\nprofile', 'private"profile', 'x'.repeat(129)]) {
    assert.throws(() => browserArgs({ browser: 'Firefox', profile }, ''), error => /Firefox Profile/.test(error.message) && !error.message.includes(profile));
  }
  assert.deepEqual(browserArgs({ browser: 'Chrome', profile: '43' }, ''), ['--profile-directory=Profile 43', '--new-window']);
});

test('system-default Firefox opens a new window without inventing a named profile, while other browser routing stays intact', () => {
  assert.deepEqual(defaultBrowserArgs('C:\\Program Files\\Mozilla Firefox\\firefox.exe', ''), ['--new-window', 'about:blank']);
  assert.deepEqual(defaultBrowserArgs('C:\\Program Files\\Mozilla Firefox\\FIREFOX.EXE', 'https://example.com/'), ['--new-window', 'https://example.com/']);
  assert.deepEqual(defaultBrowserArgs('C:\\Browser\\chrome.exe', ''), ['--new-window']);
  assert.deepEqual(defaultBrowserArgs('C:\\Other\\browser.exe', 'https://example.com/'), ['https://example.com/']);
});

test('batch entry canonicalizes Firefox aliases and accepts named Unicode profiles while still rejecting paths', async () => {
  const { blankBatchRow, validateBatchRows } = await import('../src/batch-entry.mjs');
  const result = validateBatchRows([{ ...blankBatchRow(), email: 'ff@example.com', browser: '火狐', profile: '工作 (Mail).1' }]);
  assert.deepEqual(result.errors, []); assert.equal(result.added[0].browser, 'Firefox'); assert.equal(result.added[0].profile, '工作 (Mail).1');
  const invalid = validateBatchRows([{ ...blankBatchRow(), email: 'ff@example.com', browser: 'Firefox', profile: 'C:\\private-profile' }]);
  assert.equal(invalid.errors[0].key, 'profile'); assert.ok(!invalid.errors[0].message.includes('private-profile'));
});

test('Firefox named launch requires an existing exact-case profile from its bounded registered INI catalog', () => {
  const root = path.resolve(__dirname, '../tmp'); fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, 'firefox-profile-'));
  const catalog = path.join(directory, 'Mozilla', 'Firefox', 'profiles.ini'); fs.mkdirSync(path.dirname(catalog), { recursive: true });
  fs.writeFileSync(catalog, '\uFEFF[General]\nVersion=2\n[Profile0]\nName=工作 (Mail).1\nIsRelative=1\nPath=Profiles/abc.work\n[Profile1]\nName=Work\nIsRelative=0\nPath=C:\\Profiles\\work\n');
  assert.doesNotThrow(() => ensureFirefoxProfileExists('工作 (Mail).1', { appData: directory }));
  assert.doesNotThrow(() => ensureFirefoxProfileExists('Work', { appData: directory }));
  assert.throws(() => ensureFirefoxProfileExists('work', { appData: directory }), /未找到/);
  assert.throws(() => ensureFirefoxProfileExists('private-profile-missing', { appData: directory }), error => /未找到/.test(error.message) && !error.message.includes('private-profile-missing'));
  assert.throws(() => ensureFirefoxProfileExists('Work', { appData: path.join(directory, 'missing') }), /无法读取/);
  assert.doesNotThrow(() => ensureFirefoxProfileExists('', { appData: '', readFile: () => { throw new Error('blank must not read'); } }));
});

test('Firefox malformed, orphan and duplicate registrations never produce an ambiguous profile launch', () => {
  const profile = name => `Name=${name}\nIsRelative=1\nPath=Profiles/demo\n`;
  assert.deepEqual(firefoxProfileNames('[Profile0]\n'+profile('Work')+'[Profile2]\n'+profile('Orphan')), ['Work']);
  assert.deepEqual(firefoxProfileNames('[Profile0]\nName=Work\nName=Other\nIsRelative=1\nPath=Profiles/demo\n'), []);
  assert.deepEqual(firefoxProfileNames('[Profile0]\nName=Work\nIsRelative=1\n'), []);
  assert.deepEqual(firefoxProfileNames('[Profile0]\nName =Work\nIsRelative=1\nPath=Profiles/demo\n'), []);
  assert.deepEqual(firefoxProfileNames('[Profile0]\nName= Work \nIsRelative=1\nPath=Profiles/demo\n'), [' Work ']);
  assert.throws(() => firefoxProfileNames('[Profile0]\n'+profile('Work')+'[Profile0]\n'+profile('Other')), /重复/);
  assert.throws(() => firefoxProfileNames('x'.repeat(1024 * 1024 + 1)), /格式/);
  assert.throws(() => firefoxProfileNames('[Profile0]\nName=private\0data'), /格式/);
  const duplicate = '[Profile0]\n'+profile('Work')+'[Profile1]\n'+profile('Work');
  const options = { appData: path.resolve(__dirname), statFile: () => ({ isFile: () => true, size: duplicate.length }), readFile: () => duplicate };
  assert.throws(() => ensureFirefoxProfileExists('Work', options), /重名/);
});
