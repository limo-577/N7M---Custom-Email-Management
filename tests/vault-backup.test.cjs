'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { VaultStore, encrypt, decrypt, deriveKey, parseEnvelope, CURRENT_KDF, LEGACY_KDF, BACKUP_FORMAT, MAX_ENVELOPE_BYTES, MAX_BACKUP_PLAINTEXT_BYTES } = require('../electron/vault.cjs');
const { buildBackupPayload, readBackupPayload } = require('../electron/backup.cjs');
const MASTER = 'backup and editing passphrase 01';
const NEW_MASTER = 'replacement master passphrase 02';
const SECRET = '  private password\twith exact spaces  ';
const TOTP = 'JBSWY3DPEHPK3PXP';
let normalizeState, accountKey, restoreBackup;
test.before(async () => {
  ({ normalizeState, accountKey } = await import(pathToFileURL(path.join(__dirname, '..', 'src/model.mjs')).href));
  ({ restoreBackup } = await import(pathToFileURL(path.join(__dirname, '..', 'src/mutations.mjs')).href));
});
function directory() {
  const root = path.join(__dirname, '..', 'test-results'); fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, 'vault-backup-'));
}
function entries() {
  return [
    { id: 'first', email: 'first-private@example.com', browser: 'Chrome', profile: 'Profile 1', displayId: '001', password: SECRET, totpSecret: TOTP, group: '工作', notes: 'private note', tags: ['important'], cooldownHours: 0.5,
      openedAt: 100, usedAt: 100, status: 'used', browserWindow: { hwnd: '123', token: 'private-window' }, browserTracking: 'tracked' },
    { id: 'second', email: 'second-private@example.com', browser: 'Edge', displayId: '002', password: 'another private password', group: '', notes: '', tags: [] },
  ];
}
async function storeWithData() {
  const store = new VaultStore(directory(), normalizeState); await store.setup(MASTER);
  store.save(normalizeState({ entries: entries(), groups: ['工作', '空分组'], settings: { cooldownHours: 12 } }));
  return store;
}
async function decodeVault(file, password) {
  const parsed = parseEnvelope(fs.readFileSync(file, 'utf8'));
  const key = await deriveKey(password, parsed.salt, parsed.kdf);
  try { return decrypt(parsed.value, key); } finally { key.fill(0); }
}

test('backup decoded-data budget accepts exactly 40 MiB, rejects one extra byte and preserves legacy-vault parsing', () => {
  assert.equal(MAX_BACKUP_PLAINTEXT_BYTES, 40 * 1024 * 1024);
  // Boundary-only zero-filled ciphertext, never decrypted or written to disk.
  // Adjacent decoded lengths share their base64 length: padding must be counted.
  const prefix = 'A'.repeat(Math.floor(MAX_BACKUP_PLAINTEXT_BYTES / 3) * 4);
  const atLimit = `${prefix}AA==`, overLimit = `${prefix}AAA=`;
  assert.equal(atLimit.length, overLimit.length);
  const envelope = { format: BACKUP_FORMAT, version: 1,
    kdf: { ...CURRENT_KDF, salt: Buffer.alloc(32).toString('base64') },
    cipher: { name: 'aes-256-gcm', iv: Buffer.alloc(12).toString('base64'), tag: Buffer.alloc(16).toString('base64') }, data: atLimit };
  const parsed = parseEnvelope(envelope, BACKUP_FORMAT);
  assert.equal(parsed.data.length, MAX_BACKUP_PLAINTEXT_BYTES); parsed.data.fill(0);
  assert.throws(() => parseEnvelope({ ...envelope, data: overLimit }, BACKUP_FORMAT), /格式|过大|支持/);
  const legacy = parseEnvelope({ ...envelope, format: 'N7M-VAULT', kdf: { ...LEGACY_KDF, salt: envelope.kdf.salt }, data: overLimit });
  assert.equal(legacy.data.length, MAX_BACKUP_PLAINTEXT_BYTES + 1); legacy.data.fill(0);
});

test('portable WASM Argon2id matches an independently generated fixed-parameter reference vector', async () => {
  const salt = Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex');
  const key = await deriveKey('N7M Argon2id test vector', salt);
  try { assert.equal(key.toString('hex'), 'ee24d8f197dee9d2ed51dc01962e1d2072ce2e408744eb6b783ea2d2c0f32ee6'); }
  finally { key.fill(0); }
});

test('new vaults authenticate Argon2id parameters and old scrypt snapshots upgrade without losing backup content or private metadata', async () => {
  const dir = directory(), file = path.join(dir, 'email-vault.json'), salt = crypto.randomBytes(32);
  const key = await deriveKey(MASTER, salt, LEGACY_KDF);
  const payload = { ...normalizeState(entries()), _vault: { legacyFingerprints: { 'email-data.json': 'a'.repeat(64) } } };
  const oldBackup = { ...payload, entries: payload.entries.map(entry => ({ ...entry, notes: 'older encrypted snapshot' })) };
  try {
    fs.writeFileSync(file, JSON.stringify(encrypt(payload, key, salt, LEGACY_KDF)));
    fs.writeFileSync(`${file}.bak`, JSON.stringify(encrypt(oldBackup, key, salt, LEGACY_KDF)));
  } finally { key.fill(0); }
  const store = new VaultStore(dir, normalizeState);
  await store.unlock(MASTER);
  for (const name of [file, `${file}.bak`]) {
    const envelope = parseEnvelope(fs.readFileSync(name, 'utf8'));
    assert.equal(envelope.value.version, 2); assert.deepEqual(envelope.kdf, CURRENT_KDF);
    assert.equal((await decodeVault(name, MASTER))._vault.legacyFingerprints['email-data.json'], 'a'.repeat(64));
  }
  assert.equal((await decodeVault(file, MASTER)).entries[0].notes, 'private note');
  assert.equal((await decodeVault(`${file}.bak`, MASTER)).entries[0].notes, 'older encrypted snapshot');
  assert.equal(store.requireUnlocked().entries[0].password, SECRET); store.lock();
});

test('full and selected backups preserve credentials and groups while encrypting metadata and excluding machine-local runtime identity', async () => {
  const store = await storeWithData();
  const full = await store.createBackup(undefined, MASTER);
  const selected = await store.createBackup(['first'], MASTER);
  const fullEnvelope = parseEnvelope(full, BACKUP_FORMAT), selectedEnvelope = parseEnvelope(selected, BACKUP_FORMAT);
  assert.equal(fullEnvelope.value.version, 1); assert.deepEqual(fullEnvelope.kdf, CURRENT_KDF);
  assert.notEqual(fullEnvelope.value.kdf.salt, selectedEnvelope.value.kdf.salt);
  assert.notEqual(fullEnvelope.value.cipher.iv, selectedEnvelope.value.cipher.iv);
  for (const secret of ['first-private', SECRET.trim(), TOTP, 'private note', '工作', 'private-window']) assert.equal(full.includes(secret), false);
  assert.throws(() => parseEnvelope(full), /格式|支持/);
  const restored = await store.readBackup(full, MASTER);
  assert.equal(restored.entries.length, 2); assert.deepEqual(restored.groups, ['工作', '空分组']); assert.equal(restored.settings.cooldownHours, 12);
  assert.equal(restored.entries[0].password, SECRET); assert.equal(restored.entries[0].totpSecret, TOTP);
  for (const entry of restored.entries) {
    assert.equal(entry.status, 'available'); assert.equal(entry.openedAt, null); assert.equal(entry.usedAt, null);
    assert.equal(Object.hasOwn(entry, 'browserWindow'), false); assert.equal(Object.hasOwn(entry, 'browserTracking'), false);
  }
  assert.equal(Object.hasOwn(restored, '_vault'), false);
  const restoredSelection = await store.readBackup(selected, MASTER);
  assert.deepEqual(restoredSelection.entries.map(entry => entry.id), ['first']); assert.deepEqual(restoredSelection.groups, ['工作']);
  store.lock();
});

test('encrypted backups and vault reloads preserve independent credentials for one mailbox in different browser profiles', async () => {
  const original = normalizeState({ entries: [
    { id: 'chrome-one', email: 'shared mailbox', browser: 'Chrome', profile: 'Profile 1', password: 'private chrome one', totpSecret: TOTP, notes: 'first business' },
    { id: 'chrome-plus', email: 'shared mailbox', browser: 'Chrome', profile: 'Profile+21', password: 'private literal plus', totpSecret: 'GEZDGNBVGY3TQOJQ', notes: 'second business' },
    { id: 'edge-one', email: 'shared mailbox', browser: 'Edge', profile: 'Profile 1', password: 'private edge one', totpSecret: TOTP },
    { id: 'firefox-upper', email: 'shared mailbox', browser: 'Firefox', profile: 'Work', password: 'private firefox upper', totpSecret: 'GEZDGNBVGY3TQOJQ' },
    { id: 'firefox-lower', email: 'shared mailbox', browser: 'Firefox', profile: 'work', password: 'private firefox lower', totpSecret: TOTP },
  ] });
  const credentials = state => Object.fromEntries(state.entries.map(entry => [accountKey(entry), { password: entry.password, totpSecret: entry.totpSecret }]));
  const store = new VaultStore(directory(), normalizeState);
  try {
    await store.setup(MASTER); store.save(original);
    const encrypted = await store.createBackup(undefined, MASTER), restored = await store.readBackup(encrypted, MASTER);
    assert.equal(restored.entries.length, 5);
    assert.equal(new Set(restored.entries.map(accountKey)).size, 5);
    assert.deepEqual(credentials(restored), credentials(original));
    for (const entry of original.entries) {
      assert.equal(encrypted.includes(entry.password), false);
      assert.equal(encrypted.includes(entry.totpSecret), false);
    }
    // Selection follows immutable IDs even when sibling routes share a mailbox.
    const selected = readBackupPayload(buildBackupPayload(original, ['chrome-plus', 'firefox-lower']), normalizeState);
    assert.deepEqual(selected.entries.map(entry => entry.id), ['chrome-plus', 'firefox-lower']);
    assert.deepEqual(selected.entries.map(entry => entry.password), ['private literal plus', 'private firefox lower']);
    const target = normalizeState({ entries: [...original.entries].reverse().map((entry, index) => ({ ...entry, id: `current-${index}`, password: '', totpSecret: '' })) });
    const filled = restoreBackup(target, restored, 'fill');
    assert.deepEqual(filled.counts, { added: 0, updated: 5, skipped: 0 });
    assert.deepEqual(credentials(filled.state), credentials(original));
    assert.deepEqual(filled.state.entries.map(entry => entry.id), target.entries.map(entry => entry.id));
    assert.ok(target.entries.every(entry => entry.password === '' && entry.totpSecret === ''));
    store.lock(); await store.unlock(MASTER);
    assert.deepEqual(credentials(store.requireUnlocked()), credentials(original));
    assert.equal(store.snapshot().entries.length, 5);
  } finally { store.lock(); }
});

test('bulk secret access and backup export require fresh correct authentication and never return secrets on an invalid selection', async () => {
  const store = await storeWithData(), original = fs.readFileSync(store.file, 'utf8');
  await assert.rejects(store.getEntriesForEditing(['first'], 'wrong supplied password'), /软件密码错误/);
  await assert.rejects(store.createBackup(undefined, 'wrong supplied password'), /软件密码错误/);
  await assert.rejects(store.getEntriesForEditing(['missing'], MASTER), /选择|变化/);
  const rows = await store.getEntriesForEditing(['first'], MASTER);
  assert.equal(rows.length, 1); assert.equal(rows[0].password, SECRET); assert.equal(rows[0].totpSecret, TOTP);
  assert.equal(Object.hasOwn(rows[0], 'browserWindow'), false);
  rows[0].tags.push('renderer-only'); assert.deepEqual(store.requireUnlocked().entries[0].tags, ['important']);
  assert.equal(fs.readFileSync(store.file, 'utf8'), original);
  store.lock(); await assert.rejects(store.getEntriesForEditing(['first'], MASTER), /锁定/);
});

test('external backups keep their export-time password after master rotation and can be restored using that original password', async () => {
  const store = await storeWithData(), exported = await store.createBackup(undefined, MASTER);
  await store.changePassword(MASTER, NEW_MASTER);
  assert.equal((await store.readBackup(exported, MASTER)).entries[0].password, SECRET);
  await assert.rejects(store.readBackup(exported, NEW_MASTER), /密码错误|损坏/);
  const currentExport = await store.createBackup(undefined, NEW_MASTER);
  assert.equal((await store.readBackup(currentExport, NEW_MASTER)).entries[0].password, SECRET); store.lock();
});

test('locking terminates active Argon2 workers and revokes pending credential and backup operations; authentication concurrency is bounded', async () => {
  const store = await storeWithData();
  const pending = store.getEntriesForEditing(['first'], MASTER);
  await assert.rejects(store.createBackup(undefined, MASTER), /正在处理/);
  const key = store.key; store.lock();
  await assert.rejects(pending, /锁定|取消/); assert.ok(key.every(byte => byte === 0)); assert.equal(store.key, null);
  await store.unlock(MASTER);
  const exporting = store.createBackup(undefined, MASTER); store.lock();
  await assert.rejects(exporting, /锁定|取消/);
  await store.unlock(MASTER);
  const backup = await store.createBackup(undefined, MASTER);
  const restoring = store.readBackup(backup, MASTER); store.lock();
  await assert.rejects(restoring, /锁定|取消/); assert.equal(store.authBusy, false);
});

test('backup tampering, unsupported KDF budgets, wrong domains and malformed authenticated payloads fail closed without exposing contents', async () => {
  const store = await storeWithData(), original = fs.readFileSync(store.file, 'utf8');
  const backup = await store.createBackup(undefined, MASTER), valid = JSON.parse(backup);
  for (const field of ['memory', 'passes', 'parallelism']) {
    const poisoned = structuredClone(valid); poisoned.kdf[field] = 2 ** 31;
    await assert.rejects(store.readBackup(JSON.stringify(poisoned), MASTER), /格式|支持|过大/);
  }
  const wrongDomain = { ...valid, format: 'N7M-VAULT' };
  await assert.rejects(store.readBackup(JSON.stringify(wrongDomain), MASTER), /格式|支持/);
  const changed = structuredClone(valid), bytes = Buffer.from(changed.data, 'base64'); bytes[0] ^= 1; changed.data = bytes.toString('base64');
  await assert.rejects(store.readBackup(JSON.stringify(changed), MASTER), /密码错误|损坏/);
  await assert.rejects(store.readBackup(' '.repeat(MAX_ENVELOPE_BYTES + 1), MASTER), /格式|过大/);
  const invalid = { format: 'N7M-BACKUP-PAYLOAD', version: 1, scope: 'all', state: { entries: [{ id: 'bad', email: 'account', password: { private: SECRET } }], groups: [], settings: { cooldownHours: 24 } } };
  assert.throws(() => readBackupPayload(invalid, normalizeState), /结构|限制/);
  const error = (() => { try { readBackupPayload(invalid, normalizeState); } catch (error) { return error; } })();
  assert.equal(error.message.includes(SECRET), false);
  assert.equal(fs.readFileSync(store.file, 'utf8'), original); store.lock();
});

// Deterministically delay worker exit without allocating any Argon2 memory.
// The authentication gate must remain occupied until this lifecycle boundary.
function delayedArgonWorker() {
  const vm = require('vm'), { EventEmitter } = require('events');
  const { createRequire } = require('module');
  const workers = [], timeouts = new Map(); let timerId = 0;
  class FakeWorker extends EventEmitter {
    constructor(_file, options) { super(); this.input = options.workerData; workers.push(this); }
    terminate() {
      this.terminationRequested = true;
      return new Promise(resolve => { this.finishTermination = () => { this.emit('exit', 1); resolve(1); }; });
    }
  }
  const filename = path.resolve(__dirname, '../electron/argon2.cjs');
  const nativeRequire = createRequire(filename), isolated = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: name => name === 'worker_threads' ? { Worker: FakeWorker } : nativeRequire(name),
    module: isolated, __dirname: path.dirname(filename), Uint8Array, Buffer,
    setTimeout: callback => { const id = ++timerId; timeouts.set(id, callback); return id; },
    clearTimeout: id => timeouts.delete(id)
  }, { filename });
  return { derive: isolated.exports.deriveArgon2id, workers, timeouts };
}
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

test('Argon2 cancellation retains the vault authentication gate until worker termination finishes', async () => {
  const harness = delayedArgonWorker(), vm = require('vm'), { createRequire } = require('module');
  const filename = path.resolve(__dirname, '../electron/vault.cjs'), nativeRequire = createRequire(filename), isolated = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: name => name === './argon2.cjs' ? { deriveArgon2id: harness.derive } : nativeRequire(name),
    module: isolated, Buffer, AbortController, setTimeout
  }, { filename });
  const store = new isolated.exports.VaultStore(directory(), value => value);
  store.key = Buffer.alloc(32, 7); store.salt = Buffer.alloc(32, 1); store.kdf = CURRENT_KDF; store.state = { entries: [] };
  const pending = store.reauthenticate(MASTER), rejection = assert.rejects(pending, /锁定|取消/);
  store.lock(); await nextTurn();
  assert.equal(harness.workers[0].terminationRequested, true);
  assert.equal(store.authBusy, true);
  await assert.rejects(store.reauthenticate(MASTER), /正在处理/);
  assert.equal(harness.workers.length, 1);
  harness.workers[0].finishTermination(); await rejection;
  assert.equal(store.authBusy, false);
});

test('Argon2 success waits for worker exit, returns an owned key and wipes transferred test buffers', async () => {
  const harness = delayedArgonWorker(); let settled = false;
  const pending = harness.derive(Buffer.from(MASTER), Buffer.alloc(32, 1)).then(key => { settled = true; return key; });
  const worker = harness.workers[0], messageKey = new Uint8Array(32).fill(7);
  worker.emit('message', { ok: true, key: messageKey }); await nextTurn();
  assert.equal(worker.terminationRequested, true); assert.equal(settled, false);
  assert.ok(messageKey.every(byte => byte === 0));
  worker.finishTermination(); const key = await pending;
  assert.ok(key.every(byte => byte === 7)); key.fill(0);
  assert.ok(new Uint8Array(worker.input.password).every(byte => byte === 0));
  assert.ok(new Uint8Array(worker.input.salt).every(byte => byte === 0));
});

test('locking while an Argon2 success is awaiting worker exit discards the pending key', async () => {
  const harness = delayedArgonWorker(), controller = new AbortController();
  const pending = harness.derive(Buffer.from(MASTER), Buffer.alloc(32, 1), controller.signal), rejection = assert.rejects(pending, /锁定|取消/);
  const worker = harness.workers[0]; worker.emit('message', { ok: true, key: new Uint8Array(32).fill(7) });
  controller.abort(); worker.finishTermination(); await rejection;
});

test('Argon2 timeout and worker errors do not settle before worker termination or expose raw errors', async () => {
  for (const trigger of ['timeout', 'error']) {
    const harness = delayedArgonWorker(); let settled = false;
    const pending = harness.derive(Buffer.from(MASTER), Buffer.alloc(32, 1));
    const checked = pending.then(() => assert.fail('must not derive a key'), error => { settled = true; assert.match(error.message, /超时|未能完成/); assert.equal(error.message.includes(MASTER), false); });
    const worker = harness.workers[0];
    if (trigger === 'timeout') [...harness.timeouts.values()][0]();
    else worker.emit('error', new Error(`fixture-only worker error ${MASTER}`));
    await nextTurn(); assert.equal(settled, false); assert.equal(worker.terminationRequested, true);
    worker.finishTermination(); await checked;
  }
});
