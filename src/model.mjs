export const APP_NAME = 'N7M - Custom Email Management';
export const DEFAULT_SETTINGS = { cooldownHours: 24 };
export const BROWSERS = ['Chrome', 'Edge', 'Brave', '系统默认'];
export const text = (value) => String(value ?? '').trim();
export function tagsOf(value) {
  return [...new Set((Array.isArray(value) ? value : text(value).split(/[,，;；]/)).map(text).filter(Boolean))];
}
export function hoursOf(entry, settings = DEFAULT_SETTINGS) {
  return Number(entry.cooldownHours ?? settings.cooldownHours ?? 24);
}
export function effectiveStatus(entry, settings = DEFAULT_SETTINGS, now = Date.now()) {
  return entry.status === 'used' && Number(entry.usedAt) > 0 && now - entry.usedAt < hoursOf(entry, settings) * 3600000 ? 'used' : 'available';
}
export function webUrl(value) {
  const raw = text(value);
  if (!raw) return '';
  const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(raw) ? raw : `https://${raw}`);
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw new Error('启动网页须为有效的 http / https 网址');
  return url.href;
}
export function issuesOf(entry) {
  const issues = [];
  if (!text(entry.browser)) issues.push('缺少浏览器');
  else if (!BROWSERS.includes(entry.browser)) issues.push('浏览器类型待确认');
  if (text(entry.launchUrl)) { try { webUrl(entry.launchUrl); } catch { issues.push('启动网址无效'); } }
  return issues;
}
// Canonical secrets are shared with the main-process TOTP generator. Never put
// the supplied secret itself into a validation error or a UI notification.
export function normalizeTotpSecret(value) {
  let secret = text(value);
  if (!secret) return '';
  if (/^otpauth:/i.test(secret)) {
    let uri;
    try { uri = new URL(secret); } catch { throw new Error('TOTP 链接无效，请填写 Base32 密钥或 otpauth://totp 链接'); }
    if (uri.protocol !== 'otpauth:' || uri.hostname.toLowerCase() !== 'totp') throw new Error('仅支持基于时间的 otpauth://totp 验证');
    if (uri.searchParams.getAll('secret').length !== 1) throw new Error('TOTP 链接必须包含一个 secret 密钥');
    const algorithm = (uri.searchParams.get('algorithm') || 'SHA1').toUpperCase();
    const digits = uri.searchParams.get('digits') || '6';
    const period = uri.searchParams.get('period') || '30';
    if (algorithm !== 'SHA1' || digits !== '6' || period !== '30') throw new Error('仅支持 SHA1、6 位、30 秒的 TOTP 密钥');
    secret = uri.searchParams.get('secret') || '';
  }
  secret = secret.replace(/\s/g, '').toUpperCase();
  if (!/^[A-Z2-7]+={0,6}$/.test(secret)) throw new Error('TOTP 密钥须为 Base32 字母 A-Z 与数字 2-7');
  const unpadded = secret.replace(/=+$/, '');
  if (unpadded.length < 16 || unpadded.length > 512 || ![0, 2, 4, 5, 7].includes(unpadded.length % 8)) throw new Error('TOTP 密钥长度无效，请完整粘贴密钥');
  // Base32 trailing bits must be zero, or different displayed keys could decode
  // to the same bytes and conceal a mistyped final character.
  const remaining = (unpadded.length * 5) % 8;
  if (remaining && ('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(unpadded.at(-1)) & ((1 << remaining) - 1))) throw new Error('TOTP 密钥末尾编码无效，请检查是否复制完整');
  return unpadded;
}
export function normalizeEntry(entry) {
  const browser = BROWSERS.find(b => b.toLowerCase() === text(entry.browser).toLowerCase()) || text(entry.browser);
  const normalized = { ...entry, id: entry.id || crypto.randomUUID(), email: text(entry.email), browser,
    displayId: text(entry.displayId), profile: text(entry.profile), launchUrl: text(entry.launchUrl),
    notes: text(entry.notes), group: text(entry.group), tags: tagsOf(entry.tags),
    cooldownHours: entry.cooldownHours == null || entry.cooldownHours === '' ? null : Number(entry.cooldownHours),
    status: entry.status === 'used' ? 'used' : 'available', usedAt: Number(entry.usedAt) || null };
  // Main-process snapshots deliberately omit raw credentials. Do not invent
  // blank secret fields in the renderer and accidentally erase saved secrets.
  if (Object.hasOwn(entry, 'password')) normalized.password = String(entry.password ?? '');
  if (Object.hasOwn(entry, 'totpSecret')) normalized.totpSecret = normalizeTotpSecret(entry.totpSecret);
  return normalized;
}
export function groupNamesOf(entries, catalog = []) {
  const explicit = Array.isArray(catalog) ? catalog : [];
  return [...new Set([...explicit, ...entries.map(entry => entry.group)].map(text).filter(Boolean))];
}
export function normalizeState(value) {
  if (!Array.isArray(value) && (!value || !Array.isArray(value.entries))) throw new Error('资料结构无效，预期为账号数组或包含 entries 的资料文件');
  const entries = (Array.isArray(value) ? value : value?.entries || []).map(normalizeEntry);
  return { version: 2, revision: Number(value?.revision) || 0, entries, groups: groupNamesOf(entries, value?.groups),
    settings: { ...DEFAULT_SETTINGS, ...(value?.settings || {}) } };
}
export function elapsed(ms) {
  const minutes = Math.max(0, Math.floor(ms / 60000));
  if (!minutes) return '不足 1 分钟';
  return minutes >= 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟` : `${minutes} 分钟`;
}
export function dateTime(ts) {
  return ts ? new Date(ts).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
}
// Preserve empty columns, quoted delimiters and multiline CSV notes.
export function parseDelimited(input, delimiter) {
  const source = String(input).replace(/^\uFEFF/, '');
  if (!delimiter) {
    const firstLine = source.split(/\r?\n/)[0];
    delimiter = firstLine.includes('\t') ? '\t' : ',';
  }
  const rows = []; let row = [], cell = '', quoted = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '"' && (quoted || !cell)) {
      if (quoted && source[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (c === delimiter && !quoted) { row.push(cell); cell = ''; }
    else if ((c === '\n' || c === '\r') && !quoted) {
      if (c === '\r' && source[i + 1] === '\n') i++;
      row.push(cell); if (row.some(v => text(v))) rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (quoted) throw new Error('CSV 引号未闭合，请检查文件');
  row.push(cell); if (row.some(v => text(v))) rows.push(row);
  return rows;
}
const aliases = {
  email: ['邮箱', '邮箱链接', '邮箱地址', 'email', 'account'], browser: ['浏览器', '浏览器类型', 'browser'],
  profile: ['profile', 'chrome profile', '浏览器配置'], displayId: ['编号', 'id', 'displayid'],
  launchUrl: ['启动网页', '启动网址', '打开网址', 'launchurl', 'url'], notes: ['备注', '备注信息', 'notes'],
  group: ['分组', 'group'], tags: ['标签', 'tags'], cooldownHours: ['冷却小时', '冷却时间', 'cooldownhours'],
  usedAt: ['使用时间戳', 'usedat'], status: ['状态', 'status'],
  password: ['密码', '邮箱密码', 'password'],
  totpSecret: ['totp', 'totp密钥', 'totp 密钥', 'totpsecret', '二步验证密钥', '二部验证密钥']
};
export function rowsToEntries(rows) {
  if (!rows.length) return [];
  const keys = rows[0].map(cell => Object.keys(aliases).find(key => aliases[key].includes(text(cell).toLowerCase())));
  const hasHeader = keys.includes('email');
  if (!hasHeader && keys.filter(Boolean).length >= 2) throw new Error('表头必须包含“邮箱链接”列');
  return (hasHeader ? rows.slice(1) : rows).filter(row => row.some(cell => text(cell))).map(row => {
    let item = {};
    if (hasHeader) keys.forEach((key, i) => { if (key) item[key] = row[i]; });
    else {
      const fourColumns = row.length >= 4 || /^profile\s*\d+$|^default$/i.test(text(row[2]));
      const names = fourColumns ? ['email', 'browser', 'profile', 'displayId', 'launchUrl', 'notes', 'group', 'tags', 'cooldownHours'] : ['email', 'browser', 'displayId'];
      names.forEach((key, i) => { item[key] = row[i]; });
    }
    if (item.cooldownHours !== '' && item.cooldownHours != null && (!Number.isFinite(Number(item.cooldownHours)) || Number(item.cooldownHours) <= 0 || Number(item.cooldownHours) > 8760)) throw new Error('冷却小时必须大于 0 且不超过 8760');
    item.status = ['已使用', '使用中', 'used'].includes(text(item.status)) ? 'used' : 'available';
    return normalizeEntry(item);
  });
}
export function mergeImport(existing, incoming) {
  const seen = new Set(existing.map(e => e.email.toLowerCase()));
  const added = []; let skipped = 0, invalid = 0;
  for (const entry of incoming) {
    if (!entry.email) { invalid++; continue; }
    const key = entry.email.toLowerCase();
    if (seen.has(key)) { skipped++; continue; }
    seen.add(key); added.push(entry);
  }
  return { added, skipped, invalid, incomplete: added.filter(e => issuesOf(e).length).length };
}
export function exportCsv(entries, settings = DEFAULT_SETTINGS, now = Date.now()) {
  const rows = [['编号', '邮箱链接', '浏览器', 'Profile', '启动网页', '备注', '分组', '标签', '冷却小时', '使用时间', '已用时长', '状态', '使用时间戳']];
  for (const e of entries) {
    const used = effectiveStatus(e, settings, now) === 'used';
    rows.push([e.displayId, e.email, e.browser, e.profile, e.launchUrl, e.notes, e.group, tagsOf(e.tags).join(', '), hoursOf(e, settings), used ? dateTime(e.usedAt) : '', used ? elapsed(now - e.usedAt) : '', used ? '已使用' : '可用', used ? e.usedAt : '']);
  }
  return '\uFEFF' + rows.map(row => row.map(v => {
    let value = String(v ?? '');
    if (/^[\s]*[=+@-]/.test(value)) value = "'" + value;
    return `"${value.replace(/"/g, '""')}"`;
  }).join(',')).join('\r\n');
}
