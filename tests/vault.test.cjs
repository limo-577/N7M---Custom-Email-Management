const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { VaultStore, decrypt, deriveKey, parseEnvelope } = require('../electron/vault.cjs');
const { totp } = require('../electron/totp.cjs');
const { browserArgs, defaultBrowserExecutable } = require('../electron/browser-launch.cjs');
const { trustedPage, trustedSender } = require('../electron/security.cjs');
test('IPC accepts only the application main frame at its exact trusted page', () => {
  const production = pathToFileURL(path.resolve(__dirname, '../dist/index.html')).href;
  for (const isDev of [false, true]) {
    const url = isDev ? 'http://127.0.0.1:5173/' : production;
    const mainFrame = { url }, sender = { mainFrame };
    const windows = [{ webContents: sender }];
    assert.equal(trustedSender({ sender, senderFrame: mainFrame }, windows, isDev), true);
    assert.equal(trustedPage(`${url}?toolbar=1`, isDev), true);
    assert.equal(trustedSender({ sender, senderFrame: { url } }, windows, isDev), false);
    assert.equal(trustedSender({ sender, senderFrame: mainFrame }, [], isDev), false);
    for (const invalid of ['https://evil.example/', 'about:blank', `${url}?other=1`, `${url}evil`, 'http://127.0.0.1:5173@evil.example/']) {
      mainFrame.url = invalid;
      assert.equal(trustedSender({ sender, senderFrame: mainFrame }, windows, isDev), false);
    }
  }
});
let normalizeState;
test.before(async () => { ({ normalizeState } = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'model.mjs')).href)); });
function directory() {
  const root = path.resolve(__dirname, '..', 'test-results'); fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, 'vault-unit-'));
}
const PASSWORD = 'strong vault password 01';
const NEW_PASSWORD = 'new strong vault password 02';
function initial() {
  return [{ id: 'account', email: 'private@example.com', browser: 'Chrome', displayId: '', launchUrl: '',
    password: '  account-password-do-not-trim  ', totpSecret: 'JBSWY3DPEHPK3PXP', notes: 'private note', status: 'available' }];
}
async function decodeFile(file, password) {
  const envelope = parseEnvelope(fs.readFileSync(file, 'utf8'));
  const key = await deriveKey(password, envelope.salt);
  try { return decrypt(envelope.value, key); } finally { key.fill(0); }
}
test('vault setup migrates old data, encrypts entire state and removes plaintext copies', async () => {
  const dir = directory();
  for (const name of ['email-data.json', 'email-data.json.bak', 'email-data.json.tmp']) fs.writeFileSync(path.join(dir, name), JSON.stringify(initial()));
  const store = new VaultStore(dir, normalizeState);
  assert.deepEqual(store.status(), { configured: false, locked: true, hasLegacy: true, legacyConflict: false, notice: '' });
  const snapshot = await store.setup(PASSWORD);
  assert.equal(snapshot.entries[0].hasPassword, true); assert.equal(snapshot.entries[0].hasTotp, true);
  assert.equal(Object.hasOwn(snapshot.entries[0], 'password'), false); assert.equal(Object.hasOwn(snapshot.entries[0], 'totpSecret'), false);
  assert.equal(store.requireUnlocked().entries[0].password, '  account-password-do-not-trim  ');
  for (const file of store.legacyFiles) assert.equal(fs.existsSync(file), false);
  const raw = fs.readFileSync(store.file, 'utf8');
  for (const marker of ['private@example.com', 'account-password', 'JBSWY3', 'private note']) assert.equal(raw.includes(marker), false);
  assert.equal((await decodeFile(store.file, PASSWORD)).entries[0].email, 'private@example.com');
  store.lock();
});
test('locking zeroes key buffers and revokes reading, saving and snapshots; restart starts locked', async () => {
  const store = new VaultStore(directory(), normalizeState); await store.setup(PASSWORD);
  const key = store.key; store.lock();
  assert.ok(key.every(byte => byte === 0)); assert.equal(store.status().locked, true);
  assert.throws(() => store.requireUnlocked(), /锁定/); assert.throws(() => store.snapshot(), /锁定/);
  assert.throws(() => store.save(normalizeState([])), /锁定/);
  const restarted = new VaultStore(store.directory, normalizeState);
  assert.equal(restarted.status().locked, true);
  await restarted.unlock(PASSWORD); assert.equal(restarted.status().locked, false); restarted.lock();
});
test('wrong passwords and tampered ciphertext cannot unlock or overwrite vault', async () => {
  const store = new VaultStore(directory(), normalizeState); await store.setup(PASSWORD); store.lock();
  const original = fs.readFileSync(store.file, 'utf8');
  await assert.rejects(store.unlock('incorrect password'), /密码错误/);
  assert.equal(store.status().locked, true); assert.equal(fs.readFileSync(store.file, 'utf8'), original);
  const value = JSON.parse(original); const data = Buffer.from(value.data, 'base64'); data[0] ^= 1; value.data = data.toString('base64');
  fs.writeFileSync(store.file, JSON.stringify(value));
  await assert.rejects(store.unlock(PASSWORD), /密码错误|损坏/); assert.equal(store.status().locked, true);
});
test('lock during async password derivation cancels pending unlock', async () => {
  const store = new VaultStore(directory(), normalizeState); await store.setup(PASSWORD); store.lock();
  const pending = store.unlock(PASSWORD); store.lock();
  await assert.rejects(pending, /取消|锁定/); assert.equal(store.status().locked, true); assert.equal(store.key, null);
});
test('password change reencrypts current and backup; old password cannot read either', async () => {
  const store = new VaultStore(directory(), normalizeState); await store.setup(PASSWORD);
  store.save(normalizeState(initial()));
  await assert.rejects(store.changePassword('bad password', NEW_PASSWORD), /当前软件密码错误/);
  await store.changePassword(PASSWORD, NEW_PASSWORD);
  for (const file of [store.file, `${store.file}.bak`]) {
    await assert.rejects(decodeFile(file, PASSWORD));
    assert.equal((await decodeFile(file, NEW_PASSWORD)).entries[0].email, 'private@example.com');
  }
  store.lock(); await assert.rejects(store.unlock(PASSWORD), /密码错误/); await store.unlock(NEW_PASSWORD); store.lock();
});
test('corrupt legacy plaintext is preserved and setup does not overwrite it', async () => {
  const dir = directory(), file = path.join(dir, 'email-data.json'); fs.writeFileSync(file, '{broken');
  const store = new VaultStore(dir, normalizeState);
  await assert.rejects(store.setup(PASSWORD)); assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  assert.equal(fs.existsSync(store.file), false); assert.equal(store.status().locked, true);
});
test('TOTP matches RFC 6238 SHA-1 vectors truncated to six digits', () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  for (const [seconds, expected] of [[59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037'], [20000000000, '353130']]) assert.equal(totp(secret, seconds * 1000), expected);
  assert.throws(() => totp(''), /设置/);
});
test('browser arguments omit absent startup URL and preserve explicit Profile routing', () => {
  assert.deepEqual(browserArgs({ profile: '' }, ''), ['--new-window']);
  assert.deepEqual(browserArgs({ profile: '43' }, ''), ['--profile-directory=Profile 43', '--new-window']);
  assert.deepEqual(browserArgs({ profile: 'Default' }, 'https://example.com/'), ['--profile-directory=Default', '--new-window', 'https://example.com/']);
  assert.throws(() => browserArgs({ profile: 'Profile 1" --evil' }, ''), /Profile/);
});
test('legacy files edited or created by older builds after migration are preserved on unlock', async () => {
  for (const preexisting of [false, true]) {
    const dir = directory(), file = path.join(dir, 'email-data.json');
    if (preexisting) fs.writeFileSync(file, JSON.stringify(initial()));
    const store = new VaultStore(dir, normalizeState); await store.setup(PASSWORD); store.lock();
    const newer = JSON.stringify([{ ...initial()[0], notes: 'unmigrated old-app edit' }]);
    fs.writeFileSync(file, newer);
    await store.unlock(PASSWORD);
    assert.equal(fs.readFileSync(file, 'utf8'), newer);
    assert.equal(store.status().legacyConflict, true); assert.match(store.status().notice, /尚未合并/);
    assert.equal(Object.hasOwn(store.snapshot(), '_vault'), false); store.lock();
  }
});
test('interrupted legacy cleanup deletes only exact authenticated fingerprints across saves and password changes', async () => {
  const dir = directory(), file = path.join(dir, 'email-data.json'), backup = `${file}.bak`;
  const original = JSON.stringify(initial()); fs.writeFileSync(file, original); fs.writeFileSync(backup, original);
  const store = new VaultStore(dir, normalizeState); await store.setup(PASSWORD);
  assert.ok((await decodeFile(store.file, PASSWORD))._vault.legacyFingerprints['email-data.json']);
  store.save(store.requireUnlocked()); await store.changePassword(PASSWORD, NEW_PASSWORD); store.lock();
  // The original main copy simulates an interrupted unlink; the modified backup is unmigrated data.
  fs.writeFileSync(file, original); fs.writeFileSync(backup, '{newly-corrupted-old-copy');
  await store.unlock(NEW_PASSWORD);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readFileSync(backup, 'utf8'), '{newly-corrupted-old-copy');
  assert.equal(store.status().legacyConflict, true); store.lock();
});
test('default browser resolution falls back to inherited HTTPS handler without per-user override', async () => {
  const calls = [];
  const result = await defaultBrowserExecutable(async (_exe, args) => {
    calls.push(args[1]);
    if (args[1].startsWith('HKCU')) throw new Error('no UserChoice');
    return { stdout: `    (Default)    REG_SZ    "${process.execPath}" "%1"` };
  });
  assert.equal(result, process.execPath);
  assert.equal(calls.at(-1), 'HKCR\\https\\shell\\open\\command');
});
