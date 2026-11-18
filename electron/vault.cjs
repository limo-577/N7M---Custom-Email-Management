const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);
const { deriveArgon2id } = require('./argon2.cjs');
const FORMAT = 'N7M-VAULT';
const BACKUP_FORMAT = 'N7M-BACKUP';
const MAX_ENVELOPE_BYTES = 64 * 1024 * 1024;
const MAX_BACKUP_PLAINTEXT_BYTES = 40 * 1024 * 1024;
const N = 65536, R = 8, P = 1;
const LEGACY_KDF = Object.freeze({ name: 'scrypt', N, r: R, p: P });
const CURRENT_KDF = Object.freeze({ name: 'argon2id', memory: 262144, passes: 3, parallelism: 1 });
function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 1024) throw new Error('软件密码须为 8 至 1024 个字符');
}
function bytes(value, length, maximumLength) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('资料库格式无效');
  if (length != null && value.length !== Math.ceil(length / 3) * 4) throw new Error('资料库格式无效');
  if (maximumLength != null) {
    const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
    // GCM ciphertext and plaintext have the same length. Reject over-budget
    // backups before decoding/deriving a key; keep old vault limits unchanged.
    if (value.length / 4 * 3 - padding > maximumLength) throw new Error('资料库格式无效');
  }
  const buffer = Buffer.from(value, 'base64');
  if ((length != null && buffer.length !== length) || (maximumLength != null && buffer.length > maximumLength) || buffer.toString('base64') !== value) throw new Error('资料库格式无效');
  return buffer;
}
function kdfOf(value) {
  if (value?.name === LEGACY_KDF.name && value.N === N && value.r === R && value.p === P) return LEGACY_KDF;
  if (value?.name === CURRENT_KDF.name && value.memory === CURRENT_KDF.memory && value.passes === CURRENT_KDF.passes && value.parallelism === CURRENT_KDF.parallelism) return CURRENT_KDF;
  throw new Error('资料库密钥派生参数无效或不支持');
}
function aadOf(value) {
  const kdf = kdfOf(value.kdf);
  const parameters = kdf.name === 'scrypt' ? `${kdf.name}:${kdf.N}:${kdf.r}:${kdf.p}` : `${kdf.name}:${kdf.memory}:${kdf.passes}:${kdf.parallelism}`;
  return Buffer.from(`${value.format}|${value.version}|${parameters}|aes-256-gcm`);
}
function parseEnvelope(input, expectedFormat = FORMAT) {
  let value;
  try {
    if (typeof input === 'string') {
      if (Buffer.byteLength(input, 'utf8') > MAX_ENVELOPE_BYTES) throw new Error();
      value = JSON.parse(input.replace(/^\uFEFF/, ''));
    } else value = input;
    if (![FORMAT, BACKUP_FORMAT].includes(expectedFormat) || value?.format !== expectedFormat || value.cipher?.name !== 'aes-256-gcm' || typeof value.data !== 'string' || value.data.length > MAX_ENVELOPE_BYTES) throw new Error();
    const kdf = kdfOf(value.kdf);
    if (expectedFormat === FORMAT ? !((value.version === 1 && kdf.name === 'scrypt') || (value.version === 2 && kdf.name === 'argon2id')) : value.version !== 1 || kdf.name !== 'argon2id') throw new Error();
    return { value, kdf, salt: bytes(value.kdf.salt, 32), iv: bytes(value.cipher.iv, 12), tag: bytes(value.cipher.tag, 16),
      data: bytes(value.data, undefined, expectedFormat === BACKUP_FORMAT ? MAX_BACKUP_PLAINTEXT_BYTES : undefined) };
  } catch { throw new Error('资料库格式无效、过大或版本不支持'); }
}
async function deriveKey(password, salt, parameters = CURRENT_KDF, signal) {
  if (typeof password !== 'string' || password.length > 1024 || !Buffer.isBuffer(salt) || salt.length !== 32) throw new Error('密码或密钥派生参数无效');
  const kdf = kdfOf(parameters);
  const input = Buffer.from(password, 'utf8');
  try {
    if (signal?.aborted) throw new Error('操作已因锁定而取消，请重新解锁');
    if (kdf.name === 'scrypt') {
      const key = await scrypt(input, salt, 32, { N, r: R, p: P, maxmem: 96 * 1024 * 1024 });
      if (signal?.aborted) { key.fill(0); throw new Error('操作已因锁定而取消，请重新解锁'); }
      return key;
    }
    return await deriveArgon2id(input, salt, signal);
  }
  finally { input.fill(0); }
}
function encrypt(state, key, salt, parameters = CURRENT_KDF, format = FORMAT) {
  const kdf = kdfOf(parameters);
  if (![FORMAT, BACKUP_FORMAT].includes(format) || (format === BACKUP_FORMAT && kdf.name !== 'argon2id')) throw new Error('不支持的加密资料格式');
  const envelope = { format, version: format === BACKUP_FORMAT || kdf.name === 'scrypt' ? 1 : 2,
    kdf: { ...kdf, salt: salt.toString('base64') }, cipher: { name: 'aes-256-gcm' } };
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aadOf(envelope));
  const plain = Buffer.from(JSON.stringify(state), 'utf8');
  let data;
  try {
    if (plain.length > 40 * 1024 * 1024) throw new Error('资料库内容过大，请分批备份或减少单条备注长度');
    data = Buffer.concat([cipher.update(plain), cipher.final()]);
  }
  finally { plain.fill(0); }
  return { ...envelope,
    cipher: { name: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') },
    data: data.toString('base64') };
}
function decrypt(envelope, key, expectedFormat = FORMAT) {
  const parsed = parseEnvelope(envelope, expectedFormat);
  const cipher = crypto.createDecipheriv('aes-256-gcm', key, parsed.iv);
  cipher.setAAD(aadOf(parsed.value)); cipher.setAuthTag(parsed.tag);
  let plain;
  try { plain = Buffer.concat([cipher.update(parsed.data), cipher.final()]); return JSON.parse(plain.toString('utf8')); }
  finally { plain?.fill(0); }
}
function atomicWrite(file, envelope) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${crypto.randomBytes(8).toString('hex')}`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(envelope), 'utf8'); fs.fsyncSync(descriptor);
    fs.closeSync(descriptor); descriptor = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
function sanitizeState(state) {
  const { _vault, ...visibleState } = state;
  return { ...visibleState, entries: state.entries.map(entry => {
    const { password, totpSecret, ...visible } = entry;
    return { ...visible, hasPassword: !!password, hasTotp: !!totpSecret };
  }) };
}
class VaultStore {
  constructor(directory, normalizeState) {
    this.directory = directory; this.normalizeState = normalizeState;
    this.file = path.join(directory, 'email-vault.json');
    this.legacyFiles = ['email-data.json', 'email-data.json.tmp', 'email-data.json.bak'].map(name => path.join(directory, name));
    this.key = null; this.salt = null; this.kdf = null; this.state = null; this.metadata = null;
    this.generation = 0; this.authBusy = false; this.authAbort = null; this.failedAttempts = 0; this.cleanupWarning = '';
  }
  status() {
    const hasLegacy = this.legacyFiles.some(file => fs.existsSync(file));
    const legacyConflict = !!this.key && hasLegacy;
    return { configured: fs.existsSync(this.file), locked: !this.key, hasLegacy, legacyConflict,
      notice: legacyConflict ? this.cleanupWarning || '发现新版加密后新增或修改的旧版资料文件，已保留原文件；这些内容尚未合并到加密资料库。' : '' };
  }
  fingerprint(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
  readMetadata(payload) {
    const source = payload?._vault?.legacyFingerprints || {};
    const legacyFingerprints = {};
    for (const file of this.legacyFiles) {
      const name = path.basename(file), value = source[name];
      if (typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)) legacyFingerprints[name] = value;
    }
    return { legacyFingerprints };
  }
  payload(state, metadata = this.metadata) {
    return { ...state, _vault: { legacyFingerprints: { ...(metadata?.legacyFingerprints || {}) } } };
  }
  cleanupLegacy(metadata) {
    this.cleanupWarning = '';
    for (const file of this.legacyFiles) {
      if (!fs.existsSync(file)) continue;
      const expected = metadata?.legacyFingerprints?.[path.basename(file)];
      // Files recreated or changed by an older build are never deleted.
      if (!expected) continue;
      try {
        if (this.fingerprint(fs.readFileSync(file)) === expected) fs.unlinkSync(file);
      } catch { this.cleanupWarning = '部分旧版资料文件无法清理，已保留原文件，请检查文件权限。'; }
    }
  }
  requireUnlocked(generation = this.generation) {
    if (!this.key || !this.state || generation !== this.generation) throw new Error('资料库已锁定，请先输入软件密码');
    return this.state;
  }
  guard(generation) { if (generation !== this.generation) throw new Error('操作已因锁定而取消，请重新解锁'); }
  snapshot() { return sanitizeState(this.requireUnlocked()); }
  lock() { this.generation++; this.authAbort?.abort(); this.key?.fill(0); this.key = null; this.salt = null; this.kdf = null; this.state = null; this.metadata = null; this.cleanupWarning = ''; }
  readEnvelope() {
    if (fs.statSync(this.file).size > MAX_ENVELOPE_BYTES) throw new Error('资料库文件过大，无法读取');
    return parseEnvelope(fs.readFileSync(this.file, 'utf8')).value;
  }
  async authentication(action) {
    if (this.authBusy) throw new Error('正在处理密码，请稍候');
    this.authBusy = true; const abort = new AbortController(); this.authAbort = abort;
    try { return await action(); } finally { this.authBusy = false; if (this.authAbort === abort) this.authAbort = null; }
  }
  async setup(password) {
    return this.authentication(async () => {
      validatePassword(password);
      if (this.status().configured) throw new Error('软件密码已设置，请解锁');
      const generation = this.generation, salt = crypto.randomBytes(32);
      let key;
      try {
        const originals = new Map();
        for (const file of this.legacyFiles) if (fs.existsSync(file)) originals.set(file, fs.readFileSync(file));
        const legacy = this.legacyFiles.find(file => originals.has(file));
        const metadata = { legacyFingerprints: Object.fromEntries([...originals].map(([file, buffer]) => [path.basename(file), this.fingerprint(buffer)])) };
        let state;
        try { state = this.normalizeState(legacy ? JSON.parse(originals.get(legacy).toString('utf8')) : []); }
        catch { throw new Error('旧版资料读取失败，原文件已保留，请检查文件格式'); }
        finally { for (const buffer of originals.values()) buffer.fill(0); }
        key = await deriveKey(password, salt, CURRENT_KDF, this.authAbort?.signal); this.guard(generation);
        const envelope = encrypt(this.payload(state, metadata), key, salt);
        atomicWrite(this.file, envelope);
        // Authenticate the durable file before deleting any legacy plaintext copies.
        this.normalizeState(decrypt(this.readEnvelope(), key));
        this.cleanupLegacy(metadata);
        this.key = key; key = null; this.salt = salt; this.kdf = CURRENT_KDF; this.state = state; this.metadata = metadata; this.failedAttempts = 0;
        return this.snapshot();
      } finally { key?.fill(0); }
    });
  }
  async unlock(password) {
    return this.authentication(async () => {
      if (typeof password !== 'string' || password.length > 1024) throw new Error('软件密码无效');
      if (!this.status().configured) throw new Error('请先设置软件密码');
      if (this.key) return this.snapshot();
      const generation = this.generation;
      let key;
      try {
        const envelope = this.readEnvelope(), parsed = parseEnvelope(envelope);
        key = await deriveKey(password, parsed.salt, parsed.kdf, this.authAbort?.signal); this.guard(generation);
        let state, metadata;
        try {
          const payload = decrypt(envelope, key);
          state = this.normalizeState(payload); metadata = this.readMetadata(payload);
        }
        catch {
          this.failedAttempts++;
          await new Promise(resolve => setTimeout(resolve, Math.min(8000, 500 * 2 ** Math.min(4, this.failedAttempts - 1))));
          this.guard(generation);
          throw new Error('密码错误或资料库已损坏，请检查密码');
        }
        this.guard(generation);
        let activeSalt = parsed.salt, activeKdf = parsed.kdf;
        if (parsed.kdf.name === 'scrypt') {
          const upgraded = await this.upgradeLegacyEnvelope(password, state, metadata, key, parsed, generation);
          key.fill(0); key = upgraded.key; this.guard(generation); activeSalt = upgraded.salt; activeKdf = CURRENT_KDF;
        }
        // Interrupted cleanup is finished only when the exact migrated bytes still match.
        this.cleanupLegacy(metadata);
        this.key = key; key = null; this.salt = activeSalt; this.kdf = activeKdf; this.state = state; this.metadata = metadata; this.failedAttempts = 0;
        return this.snapshot();
      } finally { key?.fill(0); }
    });
  }
  async upgradeLegacyEnvelope(password, state, metadata, legacyKey, parsed, generation) {
    const salt = crypto.randomBytes(32);
    let key, backupKey;
    try {
      key = await deriveKey(password, salt, CURRENT_KDF, this.authAbort?.signal); this.guard(generation);
      const envelope = encrypt(this.payload(state, metadata), key, salt);
      this.normalizeState(decrypt(envelope, key));
      let backupEnvelope;
      const backupFile = `${this.file}.bak`;
      if (fs.existsSync(backupFile) && fs.statSync(backupFile).size <= MAX_ENVELOPE_BYTES) {
        // Preserve the previous encrypted snapshot, including its private
        // migration metadata. An invalid backup is left untouched.
        try {
          const backup = parseEnvelope(fs.readFileSync(backupFile, 'utf8'));
          if (backup.kdf.name === parsed.kdf.name && backup.salt.equals(parsed.salt)) backupKey = legacyKey;
          else { backupKey = await deriveKey(password, backup.salt, backup.kdf, this.authAbort?.signal); this.guard(generation); }
          backupEnvelope = encrypt(decrypt(backup.value, backupKey), key, salt);
        } catch (error) { this.guard(generation); backupEnvelope = null; }
        finally { if (backupKey && backupKey !== legacyKey) backupKey.fill(0); backupKey = null; }
      }
      this.guard(generation);
      if (backupEnvelope) atomicWrite(backupFile, backupEnvelope);
      atomicWrite(this.file, envelope);
      const result = { key, salt }; key = null; return result;
    } finally { key?.fill(0); if (backupKey && backupKey !== legacyKey) backupKey.fill(0); }
  }
  save(next, generation = this.generation) {
    this.requireUnlocked(generation);
    const normalized = this.normalizeState(next);
    const encrypted = encrypt(this.payload(normalized), this.key, this.salt, this.kdf);
    if (fs.existsSync(this.file)) atomicWrite(`${this.file}.bak`, this.readEnvelope());
    atomicWrite(this.file, encrypted); this.state = normalized;
    return this.snapshot();
  }
  async verifyPassword(password, generation, message = '软件密码错误') {
    this.requireUnlocked(generation);
    if (typeof password !== 'string' || password.length > 1024) throw new Error('软件密码无效');
    let checked;
    try {
      checked = await deriveKey(password, this.salt, this.kdf, this.authAbort?.signal); this.requireUnlocked(generation);
      if (!crypto.timingSafeEqual(checked, this.key)) {
        this.failedAttempts++;
        await new Promise(resolve => setTimeout(resolve, Math.min(8000, 500 * 2 ** Math.min(4, this.failedAttempts - 1))));
        this.requireUnlocked(generation); throw new Error(message);
      }
      this.failedAttempts = 0;
    } finally { checked?.fill(0); }
  }
  async reauthenticate(password, generation = this.generation) {
    return this.authentication(async () => { await this.verifyPassword(password, generation); return true; });
  }
  async getEntriesForEditing(ids, password, generation = this.generation) {
    return this.authentication(async () => {
      await this.verifyPassword(password, generation);
      const { selectedEntries, editableEntry } = require('./backup.cjs');
      return selectedEntries(this.requireUnlocked(generation), ids).map(editableEntry);
    });
  }
  async createBackup(ids, password, generation = this.generation) {
    return this.authentication(async () => {
      await this.verifyPassword(password, generation);
      const { buildBackupPayload } = require('./backup.cjs');
      const payload = buildBackupPayload(this.requireUnlocked(generation), ids);
      const salt = crypto.randomBytes(32); let key;
      try {
        key = await deriveKey(password, salt, CURRENT_KDF, this.authAbort?.signal); this.requireUnlocked(generation);
        return JSON.stringify(encrypt(payload, key, salt, CURRENT_KDF, BACKUP_FORMAT));
      } finally { key?.fill(0); }
    });
  }
  async readBackup(input, password, generation = this.generation) {
    return this.authentication(async () => {
      this.requireUnlocked(generation);
      const parsed = parseEnvelope(input, BACKUP_FORMAT);
      let key;
      try {
        key = await deriveKey(password, parsed.salt, parsed.kdf, this.authAbort?.signal); this.requireUnlocked(generation);
        let payload;
        try { payload = decrypt(parsed.value, key, BACKUP_FORMAT); }
        catch {
          this.failedAttempts++;
          await new Promise(resolve => setTimeout(resolve, Math.min(8000, 500 * 2 ** Math.min(4, this.failedAttempts - 1))));
          this.requireUnlocked(generation); throw new Error('备份密码错误或文件已损坏');
        }
        const result = require('./backup.cjs').readBackupPayload(payload, this.normalizeState);
        this.requireUnlocked(generation); this.failedAttempts = 0; return result;
      } finally { key?.fill(0); }
    });
  }
  async changePassword(currentPassword, newPassword) {
    return this.authentication(async () => {
      validatePassword(newPassword);
      if (typeof currentPassword !== 'string' || currentPassword.length > 1024) throw new Error('当前软件密码无效');
      const generation = this.generation;
      this.requireUnlocked(generation);
      let newKey;
      try {
        await this.verifyPassword(currentPassword, generation, '当前软件密码错误');
        const salt = crypto.randomBytes(32);
        newKey = await deriveKey(newPassword, salt, CURRENT_KDF, this.authAbort?.signal); this.requireUnlocked(generation);
        const payload = this.payload(this.state);
        const envelope = encrypt(payload, newKey, salt);
        // Replace the backup too: after success an old password opens neither file.
        atomicWrite(`${this.file}.bak`, encrypt(payload, newKey, salt));
        atomicWrite(this.file, envelope);
        this.key.fill(0); this.key = newKey; newKey = null; this.salt = salt; this.kdf = CURRENT_KDF;
        return this.snapshot();
      } finally { newKey?.fill(0); }
    });
  }
}
module.exports = { VaultStore, encrypt, decrypt, deriveKey, parseEnvelope, sanitizeState, validatePassword, CURRENT_KDF, LEGACY_KDF, BACKUP_FORMAT, MAX_ENVELOPE_BYTES, MAX_BACKUP_PLAINTEXT_BYTES };
