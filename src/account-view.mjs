export const ACCOUNT_SORT_OPTIONS = [
  { value: 'original', label: '导入顺序' },
  { value: 'browser-asc', label: '浏览器类型 A → Z' },
  { value: 'browser-desc', label: '浏览器类型 Z → A' },
  { value: 'email-asc', label: '邮箱资料 A → Z' },
  { value: 'email-desc', label: '邮箱资料 Z → A' },
  { value: 'notes-asc', label: '备注 A → Z' },
  { value: 'notes-desc', label: '备注 Z → A' },
];

const fields = new Set(['browser', 'email', 'notes']);
const collators = {
  browser: new Intl.Collator('en', { sensitivity: 'base', numeric: true }),
  email: new Intl.Collator('zh-CN', { sensitivity: 'base', numeric: true }),
  notes: new Intl.Collator('zh-CN', { sensitivity: 'base', numeric: true }),
};
const sortParts = sort => typeof sort === 'string' ? /^(browser|email|notes)-(asc|desc)$/.exec(sort) : null;
const valueOf = value => String(value ?? '').trim();

export function sortAccounts(entries, sort) {
  const source = Array.isArray(entries) ? entries : [];
  const parts = sortParts(sort);
  if (!parts) return [...source];
  const [, field, direction] = parts, sign = direction === 'desc' ? -1 : 1;
  return source.map((entry, index) => ({ entry, index, value: valueOf(entry?.[field]) }))
    .sort((a, b) => {
      // Empty values remain last even when the nonempty values are descending.
      if (!a.value || !b.value) return Number(!a.value) - Number(!b.value) || a.index - b.index;
      return collators[field].compare(a.value, b.value) * sign || a.index - b.index;
    }).map(({ entry }) => entry);
}

export function nextAccountSort(current, field) {
  if (!fields.has(field)) return 'original';
  const parts = sortParts(current);
  if (!parts || parts[1] !== field) return `${field}-asc`;
  return parts[2] === 'asc' ? `${field}-desc` : 'original';
}

export function accountSortDirection(sort, field) {
  const parts = sortParts(sort);
  if (!parts || parts[1] !== field) return 'none';
  return parts[2] === 'asc' ? 'ascending' : 'descending';
}
