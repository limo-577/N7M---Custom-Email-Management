import { BROWSERS, browserNameOf, profileIssueOf, normalizeTotpSecret, tagsOf, text, webUrl, accountKey } from './model.mjs';
import { BATCH_COLUMNS, MAX_BATCH_ROWS, parseGridClipboard } from './batch-entry.mjs';

export const BULK_EDIT_COLUMNS = BATCH_COLUMNS;
export const MAX_BULK_EDIT_ROWS = MAX_BATCH_ROWS;
export { parseGridClipboard };

export function makeBulkDrafts(entries) {
  return entries.map(entry => ({ id: entry.id, ...Object.fromEntries(BULK_EDIT_COLUMNS.map(({ key }) => [key,
    key === 'tags' ? tagsOf(entry.tags).join(', ') : key === 'cooldownHours' ? String(entry.cooldownHours ?? '') : String(entry[key] ?? '')
  ])) }));
}

export function applyBulkPaste(rows, startRow, startColumn, matrix, blocked = () => false) {
  if (!Number.isInteger(startRow) || !Number.isInteger(startColumn) || startRow < 0 || startColumn < 0 || !Array.isArray(matrix) ||
    startRow + matrix.length > rows.length || matrix.some(row => !Array.isArray(row) || startColumn + row.length > BULK_EDIT_COLUMNS.length)) {
    throw new Error('粘贴范围超出当前账号表格，请调整起始单元格或粘贴内容');
  }
  // Validate the complete rectangle before touching any cell. In particular,
  // pasted columns must not bypass an active browser's read-only routing cells.
  matrix.forEach((row, offset) => row.forEach((value, column) => {
    if (blocked(startRow + offset, BULK_EDIT_COLUMNS[startColumn + column].key, String(value ?? ''))) throw new Error('粘贴范围包含已打开浏览器的类型或 Profile，请先关闭对应浏览器');
  }));
  const next = rows.map(row => ({ ...row }));
  matrix.forEach((row, offset) => row.forEach((value, column) => { next[startRow + offset][BULK_EDIT_COLUMNS[startColumn + column].key] = String(value ?? ''); }));
  return next;
}

function same(value, other) { return Array.isArray(value) ? JSON.stringify(value) === JSON.stringify(other) : value === other; }
function normalizedField(key, value) {
  if (key === 'password') return String(value ?? '');
  if (key === 'totpSecret') return normalizeTotpSecret(value);
  if (key === 'tags') return tagsOf(value);
  if (key === 'cooldownHours') return text(value) === '' ? null : Number(value);
  if (key === 'browser') return browserNameOf(value);
  if (key === 'launchUrl') return text(value) ? webUrl(value) : '';
  return text(value);
}

export function generateBulkPatches(originalEntries, drafts, allEntries = originalEntries) {
  if (!Array.isArray(originalEntries) || !Array.isArray(drafts) || !Array.isArray(allEntries) ||
    originalEntries.length > MAX_BULK_EDIT_ROWS || originalEntries.length !== drafts.length ||
    new Set(originalEntries.map(entry => entry?.id)).size !== originalEntries.length ||
    originalEntries.some((entry, index) => !entry || typeof entry.id !== 'string' || !entry.id || entry.id !== drafts[index]?.id)) {
    throw new Error('批量编辑会话资料已变化，请重新验证软件密码');
  }
  const baseline = makeBulkDrafts(originalEntries), patches = [], errors = [];
  const live = new Map(allEntries.map(entry => [entry.id, entry]));
  const selected = new Set(originalEntries.map(entry => entry.id));
  const outsideAccounts = new Set(allEntries.filter(entry => !selected.has(entry.id)).map(accountKey));
  const identities = new Map();
  drafts.forEach((row, rowIndex) => {
    const key = accountKey(row);
    if (text(row.email)) identities.set(key, [...(identities.get(key) || []), rowIndex]);
  });
  drafts.forEach((row, rowIndex) => {
    const original = originalEntries[rowIndex], rawOriginal = baseline[rowIndex], patch = {};
    const fail = (key, message) => errors.push({ row: rowIndex, key, message });
    if (!text(row.email)) fail('email', '邮箱资料不能为空');
    const identity = accountKey(row);
    if (text(row.email) && (outsideAccounts.has(identity) || identities.get(identity)?.length > 1)) fail('email', '邮箱资料、浏览器和 Profile 组合重复，请检查重复记录');
    if (allEntries.length && !live.has(row.id)) fail('email', '账号已删除，请重新打开批量编辑');
    const browser = browserNameOf(row.browser), profile = text(row.profile);
    const routingChanged = browser !== browserNameOf(original.browser) || profile !== text(original.profile);
    if (routingChanged) {
      if (browser && !BROWSERS.includes(browser)) fail('browser', '请选择支持的浏览器，或留空标记待完善');
      const profileError = profileIssueOf(browser, profile);
      if (profileError) fail('profile', profileError);
    }
    for (const { key } of BULK_EDIT_COLUMNS) {
      if (String(row[key] ?? '') === rawOriginal[key]) continue;
      if ((key === 'browser' || key === 'profile') && (live.get(row.id) || original).browserWindow) {
        // Ignore text-only canonicalization, such as changing chrome to Chrome.
        if ((key === 'browser' ? browser : profile) !== (key === 'browser' ? browserNameOf(original.browser) : text(original.profile))) {
          fail(key, '浏览器已打开，请先关闭对应窗口再修改此字段');
          continue;
        }
      }
      if (key === 'cooldownHours' && text(row[key]) && (!Number.isFinite(Number(row[key])) || Number(row[key]) <= 0 || Number(row[key]) > 8760)) {
        fail(key, '冷却小时须大于 0 且不超过 8760'); continue;
      }
      if (key === 'group' && (text(row[key]).length > 80 || text(row[key]) === '__none')) {
        fail(key, '分组名称须在 80 个字符以内，且不能使用系统保留名称'); continue;
      }
      let value, previous;
      try { value = normalizedField(key, row[key]); }
      catch {
        fail(key, key === 'totpSecret' ? 'TOTP 密钥无效，请填写完整的 Base32 密钥或受支持的 otpauth://totp 链接' : '启动网页须为有效的 http / https 网址');
        continue;
      }
      try { previous = normalizedField(key, original[key]); } catch { previous = original[key]; }
      if (!same(value, previous)) patch[key] = value;
    }
    if (Object.keys(patch).length) patches.push({ id: row.id, patch });
  });
  return { patches, errors, changedRows: patches.length, changedFields: patches.reduce((sum, item) => sum + Object.keys(item.patch).length, 0) };
}
