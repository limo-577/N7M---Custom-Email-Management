const crypto = require('crypto');
function decodeBase32(value) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, count = 0; const bytes = [];
  for (const character of value) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error('TOTP 密钥必须是 Base32 格式');
    bits = (bits << 5) | index; count += 5;
    if (count >= 8) { count -= 8; bytes.push((bits >>> count) & 255); }
  }
  if (count && (bits & ((1 << count) - 1))) throw new Error('TOTP 密钥末尾无效');
  if (!bytes.length) throw new Error('请先设置 TOTP 密钥');
  return Buffer.from(bytes);
}
function totp(secret, now = Date.now()) {
  if (!/^[A-Z2-7]{16,512}$/.test(secret || '')) throw new Error('请先设置有效的 TOTP 密钥');
  const key = decodeBase32(secret);
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(now / 30000)));
  let digest;
  try {
    digest = crypto.createHmac('sha1', key).update(counter).digest();
    const offset = digest[digest.length - 1] & 15;
    return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
  } finally { key.fill(0); counter.fill(0); digest?.fill(0); }
}
module.exports = { totp, decodeBase32 };
