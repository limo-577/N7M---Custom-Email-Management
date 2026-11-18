'use strict';
const crypto = require('crypto');
const FIELDS = ['email', 'browser', 'profile', 'displayId', 'launchUrl', 'notes', 'group', 'tags', 'cooldownHours', 'password', 'totpSecret'];
class EditSessions {
  constructor({ now = Date.now, ttl = 5 * 60000 } = {}) { this.now = now; this.ttl = ttl; this.sessions = new Map(); }
  digest(key, value) { return crypto.createHmac('sha256', key).update(JSON.stringify(value ?? null)).digest(); }
  revoke(token) { const session = this.sessions.get(token); if (session) { session.key.fill(0); this.sessions.delete(token); } }
  sweep() { for (const [token, session] of this.sessions) if (this.now() >= session.expiresAt) this.revoke(token); }
  clear(sender) { for (const [token, session] of this.sessions) if (sender == null || session.sender === sender) this.revoke(token); }
  create(entries, sender, generation, { maxRows = 1000, maxCharacters = 4 * 1024 * 1024 } = {}) {
    this.clear(sender);
    const key = crypto.randomBytes(32), token = crypto.randomBytes(32).toString('base64url'), expiresAt = this.now() + this.ttl;
    const baselines = new Map(entries.map(entry => [entry.id, new Map(FIELDS.map(name => [name, this.digest(key, entry[name])]))]));
    this.sessions.set(token, { key, baselines, sender, generation, expiresAt, maxRows, maxCharacters });
    return { token, expiresAt };
  }
  validate(token, patches, currentEntries, sender, generation) {
    const session = typeof token === 'string' && this.sessions.get(token);
    if (!session || session.sender !== sender || session.generation !== generation || this.now() >= session.expiresAt) {
      if (session && (this.now() >= session.expiresAt || session.generation !== generation)) this.revoke(token);
      throw new Error('批量编辑验证已失效，请重新输入软件密码');
    }
    if (!Array.isArray(patches) || patches.length > session.maxRows) throw new Error('本次修改的账号数量超出验证范围');
    const current = new Map(currentEntries.map(entry => [entry.id, entry])), seen = new Set();
    let totalCharacters = 0;
    for (const item of patches) {
      if (!item || seen.has(item.id) || !current.has(item.id) || !session.baselines.has(item.id) || !item.patch || typeof item.patch !== 'object' || Array.isArray(item.patch)) throw new Error('账号选择已变化，请重新验证并载入资料');
      seen.add(item.id);
      for (const name of Object.keys(item.patch)) {
        if (!FIELDS.includes(name)) throw new Error('修改字段无效');
        const value = item.patch[name];
        if (value !== null && !['string', 'number'].includes(typeof value) && !(name === 'tags' && Array.isArray(value) && value.every(tag => typeof tag === 'string'))) throw new Error('修改内容格式无效');
        totalCharacters += JSON.stringify(value ?? null).length;
        if (totalCharacters > session.maxCharacters) throw new Error('批量修改内容过大，请分批保存');
        const digest = this.digest(session.key, current.get(item.id)[name]);
        if (!crypto.timingSafeEqual(digest, session.baselines.get(item.id).get(name))) throw new Error('这些字段已在其他窗口修改，请重新验证并载入最新资料');
      }
    }
    return session;
  }
}
module.exports = { EditSessions };
