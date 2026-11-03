const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);
const FORMAT = 'N7M-VAULT';
const N = 65536, R = 8, P = 1;
const AAD = Buffer.from('N7M-VAULT|1|scrypt:65536:8:1|aes-256-gcm');
function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 1024) throw new Error('软件密码须为 8 至 1024 个字符');
}
function bytes(value, length) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('资料库格式无效');
  const buffer = Buffer.from(value, 'base64');
  if ((length != null && buffer.length !== length) || buffer.toString('base64') !== value) throw new Error('资料库格式无效');
  return buffer;
}
function parseEnvelope(input) {
  const value = typeof input === 'string' ? JSON.parse(input) : input;
  if (value?.format !== FORMAT || value.version !== 1 || value.kdf?.name !== 'scrypt' || value.kdf.N !== N || value.kdf.r !== R || value.kdf.p !== P || value.cipher?.name !== 'aes-256-gcm') throw new Error('资料库格式无效或版本不支持');
  return { value, salt: bytes(value.kdf.salt, 32), iv: bytes(value.cipher.iv, 12), tag: bytes(value.cipher.tag, 16), data: bytes(value.data) };
}
async function deriveKey(password, salt) {
  const input = Buffer.from(password, 'utf8');
  try { return await scrypt(input, salt, 32, { N, r: R, p: P, maxmem: 96 * 1024 * 1024 }); }
  finally { input.fill(0); }
}
function encrypt(state, key, salt) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(AAD);
  const plain = Buffer.from(JSON.stringify(state), 'utf8');
  let data;
  try { data = Buffer.concat([cipher.update(plain), cipher.final()]); }
  finally { plain.fill(0); }
  return { format: FORMAT, version: 1,
    kdf: { name: 'scrypt', N, r: R, p: P, salt: salt.toString('base64') },
    cipher: { name: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') },
    data: data.toString('base64') };
}
function decrypt(envelope, key) {
  const parsed = parseEnvelope(envelope);
  const cipher = crypto.createDecipheriv('aes-256-gcm', key, parsed.iv);
  cipher.setAAD(AAD); cipher.setAuthTag(parsed.tag);
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
    this.key = null; this.salt = null; this.state = null; this.metadata = null;
    this.generation = 0; this.authBusy = false; this.failedAttempts = 0; this.cleanupWarning = '';
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
  lock() { this.generation++; this.key?.fill(0); this.key = null; this.salt = null; this.state = null; this.metadata = null; this.cleanupWarning = ''; }
  readEnvelope() { return parseEnvelope(fs.readFileSync(this.file, 'utf8')).value; }
  async authentication(action) {
    if (this.authBusy) throw new Error('正在处理密码，请稍候');
    this.authBusy = true;
    try { return await action(); } finally { this.authBusy = false; }
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
        key = await deriveKey(password, salt); this.guard(generation);
        const envelope = encrypt(this.payload(state, metadata), key, salt);
        atomicWrite(this.file, envelope);
        // Authenticate the durable file before deleting any legacy plaintext copies.
        this.normalizeState(decrypt(this.readEnvelope(), key));
        this.cleanupLegacy(metadata);
        this.key = key; key = null; this.salt = salt; this.state = state; this.metadata = metadata; this.failedAttempts = 0;
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
        key = await deriveKey(password, parsed.salt); this.guard(generation);
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
        // Interrupted cleanup is finished only when the exact migrated bytes still match.
        this.cleanupLegacy(metadata);
        this.key = key; key = null; this.salt = parsed.salt; this.state = state; this.metadata = metadata; this.failedAttempts = 0;
        return this.snapshot();
      } finally { key?.fill(0); }
    });
  }
  save(next, generation = this.generation) {
    this.requireUnlocked(generation);
    const normalized = this.normalizeState(next);
    const encrypted = encrypt(this.payload(normalized), this.key, this.salt);
    if (fs.existsSync(this.file)) atomicWrite(`${this.file}.bak`, this.readEnvelope());
    atomicWrite(this.file, encrypted); this.state = normalized;
    return this.snapshot();
  }
  async changePassword(currentPassword, newPassword) {
    return this.authentication(async () => {
      validatePassword(newPassword);
      if (typeof currentPassword !== 'string' || currentPassword.length > 1024) throw new Error('当前软件密码无效');
      const generation = this.generation;
      this.requireUnlocked(generation);
      let currentKey, newKey;
      try {
        currentKey = await deriveKey(currentPassword, this.salt); this.requireUnlocked(generation);
        if (!crypto.timingSafeEqual(currentKey, this.key)) {
          await new Promise(resolve => setTimeout(resolve, 700)); this.requireUnlocked(generation);
          throw new Error('当前软件密码错误');
        }
        const salt = crypto.randomBytes(32);
        newKey = await deriveKey(newPassword, salt); this.requireUnlocked(generation);
        const payload = this.payload(this.state);
        const envelope = encrypt(payload, newKey, salt);
        // Replace the backup too: after success an old password opens neither file.
        atomicWrite(`${this.file}.bak`, encrypt(payload, newKey, salt));
        atomicWrite(this.file, envelope);
        this.key.fill(0); this.key = newKey; newKey = null; this.salt = salt;
        return this.snapshot();
      } finally { currentKey?.fill(0); newKey?.fill(0); }
    });
  }
}
module.exports = { VaultStore, encrypt, decrypt, deriveKey, parseEnvelope, sanitizeState, validatePassword };
