import { BROWSERS, browserNameOf, profileIssueOf, mergeImport, normalizeEntry, webUrl } from './model.mjs';

export const MAX_BATCH_ROWS = 1000;
export const BATCH_COLUMNS = [
  { key: 'email', label: '邮箱资料', required: true, width: 240 },
  { key: 'browser', label: '浏览器', width: 140 },
  { key: 'profile', label: 'Profile', width: 145 },
  { key: 'displayId', label: '软件编号', width: 115 },
  { key: 'launchUrl', label: '启动网页', width: 230 },
  { key: 'notes', label: '备注', width: 240 },
  { key: 'group', label: '分组', width: 145 },
  { key: 'tags', label: '标签', width: 150 },
  { key: 'cooldownHours', label: '冷却小时', width: 115 },
  { key: 'password', label: '密码', secret: true, width: 175 },
  { key: 'totpSecret', label: 'TOTP 密钥', secret: true, width: 225 },
];
// Add-account entry stays compact. Bulk editing retains the complete field list.
export const BATCH_ENTRY_COLUMNS = ['email', 'browser', 'profile', 'notes', 'group', 'password', 'totpSecret']
  .map(key => ({ ...BATCH_COLUMNS.find(column => column.key === key), width: key === 'email' ? 150 : 80 }));
export const blankBatchRow = () => ({ _key: crypto.randomUUID(), ...Object.fromEntries(BATCH_COLUMNS.map(({ key }) => [key, ''])) });
export const hasBatchContent = row => BATCH_COLUMNS.some(({ key }) => String(row[key] ?? '').trim());

// Unlike file imports, a rectangular paste must retain empty middle rows so
// cells after a gap keep their original spreadsheet coordinates.
export function parseGridClipboard(input) {
  const source = String(input).replace(/^\uFEFF/, '');
  if (source.length > 2 * 1024 * 1024) throw new Error('粘贴内容过大，请分批录入');
  const result = []; let row = [], cell = '', quoted = false;
  const endRow = () => {
    row.push(cell); result.push(row); row = []; cell = '';
    if (result.length > MAX_BATCH_ROWS) throw new Error(`每次最多录入 ${MAX_BATCH_ROWS} 行，请分批录入`);
  };
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '"' && (quoted || !cell)) {
      if (quoted && source[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (c === '\t' && !quoted) { row.push(cell); cell = ''; }
    else if ((c === '\n' || c === '\r') && !quoted) {
      if (c === '\r' && source[i + 1] === '\n') i++;
      endRow();
    } else cell += c;
  }
  if (quoted) throw new Error('粘贴内容的引号未闭合，请检查后重试');
  if (cell || row.length || !result.length) endRow();
  return result;
}

export function applyGridPaste(rows, startRow, startColumn, matrix, columns = BATCH_COLUMNS) {
  if (!Array.isArray(rows) || !Number.isInteger(startRow) || !Number.isInteger(startColumn) || startRow < 0 || startColumn < 0 || !Array.isArray(matrix) || !Array.isArray(columns) || !columns.length ||
    columns.some(column => !BATCH_COLUMNS.some(known => known.key === column?.key)) || matrix.some(row => !Array.isArray(row))) throw new Error('粘贴范围无效，请从正确的单元格开始粘贴');
  if (startRow + matrix.length > MAX_BATCH_ROWS) throw new Error(`每次最多录入 ${MAX_BATCH_ROWS} 行，请分批录入`);
  if (matrix.some(row => startColumn + row.length > columns.length)) throw new Error('粘贴列数超出表格，请从正确的列开始粘贴');
  const next = rows.map(row => ({ ...row }));
  while (next.length < startRow + matrix.length) next.push(blankBatchRow());
  matrix.forEach((row, offset) => row.forEach((value, column) => { next[startRow + offset][columns[startColumn + column].key] = value; }));
  return next;
}

export function validateBatchRows(rows, existingEntries = []) {
  const incoming = [], errors = [];
  rows.forEach((row, index) => {
    if (!hasBatchContent(row)) return;
    const fail = (key, message) => errors.push({ row: index, key, message });
    const before = errors.length;
    if (!String(row.email ?? '').trim()) fail('email', '请填写邮箱资料');
    const canonicalBrowser = browserNameOf(row.browser);
    const browser = BROWSERS.includes(canonicalBrowser) ? canonicalBrowser : undefined;
    if (String(row.browser ?? '').trim() && !browser) fail('browser', '请选择 Chrome、Edge、Brave、Firefox 或系统默认');
    const profile = String(row.profile ?? '').trim();
    const profileIssue = profileIssueOf(browser, profile);
    if (profileIssue) fail('profile', browser === 'Firefox' ? profileIssue : 'Profile 只支持字母、数字、空格、加号、下划线和连字符，请填写目录名而非完整路径');
    if (String(row.launchUrl ?? '').trim()) {
      try { webUrl(row.launchUrl); } catch { fail('launchUrl', '启动网页须为有效的 http / https 网址'); }
    }
    const hours = String(row.cooldownHours ?? '').trim();
    if (hours && (!Number.isFinite(Number(hours)) || Number(hours) <= 0 || Number(hours) > 8760)) fail('cooldownHours', '冷却小时须大于 0 且不超过 8760');
    if (String(row.group ?? '').trim().length > 80) fail('group', '分组名称不能超过 80 个字符');
    if (String(row.group ?? '').trim() === '__none') fail('group', '此分组名称为系统保留名称，请使用其他名称');
    if (before !== errors.length) return;
    try {
      // Explicit fields keep internal row keys out of the encrypted account.
      const entry = normalizeEntry({ ...Object.fromEntries(BATCH_COLUMNS.map(({ key }) => [key, row[key] ?? ''])), cooldownHours: hours || '' });
      if (entry.launchUrl) entry.launchUrl = webUrl(entry.launchUrl);
      incoming.push(entry);
    } catch {
      fail('totpSecret', 'TOTP 密钥无效，请填写完整的 Base32 密钥或 SHA1 / 6 位 / 30 秒的 otpauth://totp 链接');
    }
  });
  return { ...mergeImport(existingEntries, incoming), errors, filled: rows.filter(hasBatchContent).length };
}
