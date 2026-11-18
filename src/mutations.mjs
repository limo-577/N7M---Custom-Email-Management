import { normalizeEntry, numberMissingEntries, BROWSERS, webUrl, groupNamesOf, profileIssueOf, accountKey, text } from './model.mjs';
export const EDITABLE_FIELDS = ['email', 'browser', 'profile', 'displayId', 'launchUrl', 'notes', 'group', 'tags', 'cooldownHours', 'password', 'totpSecret'];
function validatedPatch(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('账号修改资料无效');
  const patch = {};
  for (const key of EDITABLE_FIELDS) if (Object.hasOwn(value, key)) patch[key] = value[key];
  if (Object.hasOwn(patch, 'browser') && patch.browser && !BROWSERS.includes(patch.browser)) throw new Error('请选择支持的浏览器');
  if (patch.launchUrl) patch.launchUrl = webUrl(patch.launchUrl);
  if (patch.cooldownHours != null && patch.cooldownHours !== '' && (!Number.isFinite(Number(patch.cooldownHours)) || Number(patch.cooldownHours) <= 0 || Number(patch.cooldownHours) > 8760)) throw new Error('冷却小时必须大于 0 且不超过 8760');
  return patch;
}
function updatedEntry(entry, patch) {
  const updated = normalizeEntry({ ...entry, ...patch });
  if (updated.browser !== entry.browser || updated.profile !== entry.profile) { updated.openedAt = null; delete updated.browserWindow; delete updated.browserTracking; delete updated.browserTrackingReason; }
  return updated;
}
function uniqueAccounts(entries) {
  const seen = new Set();
  for (const entry of entries) {
    if (!entry.email) throw new Error('邮箱资料不能为空');
    const key = accountKey(entry);
    if (seen.has(key)) throw new Error('邮箱资料、浏览器和 Profile 组合重复，请检查重复记录');
    seen.add(key);
  }
}
function newGroupName(value) {
  const name = text(value);
  if (!name) throw new Error('请填写分组名称');
  if (name.length > 80) throw new Error('分组名称不能超过 80 个字符');
  if (name === '__none') throw new Error('此分组名称为系统保留名称，请使用其他名称');
  return name;
}
export function applyMutation(state, operation) {
  const ids = new Set(operation.ids || []);
  let entries = state.entries, settings = state.settings, groups = groupNamesOf(state.entries, state.groups);
  if (operation.type === 'import') {
    const seen = new Set(entries.map(accountKey));
    const usedIds = new Set(entries.map(entry => entry.id));
    const added = (operation.entries || []).map(normalizeEntry).filter(e => {
      const key = accountKey(e);
      if (!e.email || seen.has(key)) return false;
      seen.add(key); return true;
    }).map(entry => {
      const addedEntry = usedIds.has(entry.id) || typeof entry.id !== 'string' || !entry.id || entry.id.length > 256 ? { ...entry, id: crypto.randomUUID() } : entry;
      usedIds.add(addedEntry.id); return addedEntry;
    });
    entries = [...entries, ...added];
  } else if (operation.type === 'update') {
    const patch = validatedPatch(operation.patch);
    entries = entries.map(entry => ids.has(entry.id) ? updatedEntry(entry, patch) : entry);
    uniqueAccounts(entries);
  } else if (operation.type === 'update-many') {
    if (!Array.isArray(operation.patches) || operation.patches.length > 1000) throw new Error('每次最多修改 1000 个账号');
    const patches = new Map(), existing = new Set(entries.map(entry => entry.id));
    for (const item of operation.patches) {
      if (!item || !existing.has(item.id) || patches.has(item.id)) throw new Error('账号选择已变化，请重新载入');
      const patch = validatedPatch(item.patch);
      for (const [key, value] of Object.entries(patch)) {
        if (typeof value === 'string' && value.length > (key === 'notes' ? 32767 : 8192)) throw new Error('填写内容过长，请缩短后重试');
      }
      if (patch.group && (text(patch.group).length > 80 || text(patch.group) === '__none')) throw new Error('分组名称无效');
      patches.set(item.id, patch);
    }
    entries = entries.map(entry => {
      if (!patches.has(entry.id)) return entry;
      const patch = patches.get(entry.id), updated = updatedEntry(entry, patch);
      if ((Object.hasOwn(patch, 'profile') || Object.hasOwn(patch, 'browser')) && profileIssueOf(updated.browser, updated.profile)) throw new Error(profileIssueOf(updated.browser, updated.profile));
      return updated;
    });
    // Check the final table once so swapping two addresses is atomic and valid.
    uniqueAccounts(entries);
  } else if (operation.type === 'group-add') {
    const name = newGroupName(operation.name);
    if (groups.includes(name)) throw new Error('该分组已存在');
    groups = [...groups, name];
  } else if (operation.type === 'group-delete') {
    const name = text(operation.name);
    if (!name || !groups.includes(name)) throw new Error('分组不存在，请刷新后重试');
    groups = groups.filter(group => group !== name);
    entries = entries.map(entry => entry.group === name ? { ...entry, group: '' } : entry);
  } else if (operation.type === 'group-rename') {
    const name = text(operation.name), newName = newGroupName(operation.newName);
    if (!name || !groups.includes(name)) throw new Error('分组不存在，请刷新后重试');
    if (newName !== name && groups.includes(newName)) throw new Error('该分组已存在');
    groups = groups.map(group => group === name ? newName : group);
    entries = entries.map(entry => entry.group === name ? { ...entry, group: newName } : entry);
  } else if (operation.type === 'delete') entries = entries.filter(e => !ids.has(e.id));
  else if (operation.type === 'reset') entries = entries.map(e => ids.has(e.id) ? { ...e, status: 'available', usedAt: null } : e);
  else if (operation.type === 'settings') {
    const value = Number(operation.cooldownHours);
    if (!Number.isFinite(value) || value <= 0 || value > 8760) throw new Error('默认冷却小时必须大于 0 且不超过 8760');
    settings = { ...settings, cooldownHours: value };
  } else throw new Error('不支持的操作');
  entries = numberMissingEntries(entries);
  return { ...state, revision: state.revision + 1, entries, settings, groups: groupNamesOf(entries, groups) };
}

export function restoreBackup(state, backup, policy = 'fill', restoreSettings = false) {
  if (!['fill', 'overwrite', 'add'].includes(policy) || !backup || !Array.isArray(backup.entries)) throw new Error('备份恢复选项无效');
  const byIdentity = new Map(state.entries.map(entry => [accountKey(entry), entry]));
  const seen = new Set(), changes = new Map(), additions = [], usedDisplayIds = new Set(state.entries.map(entry => entry.displayId));
  const counts = { added: 0, updated: 0, skipped: 0 };
  for (const incoming of backup.entries) {
    const email = text(incoming.email), key = accountKey(incoming);
    if (!email || seen.has(key)) throw new Error('备份中的邮箱资料为空或账号组合重复，未修改现有资料');
    seen.add(key);
    const fields = Object.fromEntries(EDITABLE_FIELDS.filter(name => Object.hasOwn(incoming, name)).map(name => [name, incoming[name]]));
    const current = byIdentity.get(key);
    if (!current) {
      if (usedDisplayIds.has(text(fields.displayId))) fields.displayId = '';
      const entry = normalizeEntry({ ...fields, id: crypto.randomUUID(), status: 'available', usedAt: null, openedAt: null });
      usedDisplayIds.add(entry.displayId); additions.push(entry); counts.added++;
      continue;
    }
    if (policy === 'add') { counts.skipped++; continue; }
    const patch = {};
    for (const name of EDITABLE_FIELDS) {
      if (name === 'email' || !Object.hasOwn(fields, name)) continue;
      const missing = current[name] == null || current[name] === '' || (Array.isArray(current[name]) && !current[name].length);
      if ((policy === 'overwrite' || missing) && JSON.stringify(current[name] ?? null) !== JSON.stringify(fields[name] ?? null)) patch[name] = fields[name];
    }
    if (!Object.keys(patch).length) { counts.skipped++; continue; }
    if (current.browserWindow && ['browser', 'profile'].some(name => Object.hasOwn(patch, name) && patch[name] !== current[name])) throw new Error('备份会改变正在打开的浏览器配置，请先关闭对应窗口再恢复');
    changes.set(current.id, updatedEntry(current, validatedPatch(patch))); counts.updated++;
  }
  const entries = numberMissingEntries([...state.entries.map(entry => changes.get(entry.id) || entry), ...additions]);
  uniqueAccounts(entries);
  const settings = restoreSettings ? { ...state.settings, cooldownHours: Number(backup.settings?.cooldownHours) } : state.settings;
  if (!Number.isFinite(Number(settings.cooldownHours)) || settings.cooldownHours <= 0 || settings.cooldownHours > 8760) throw new Error('备份冷却设置无效');
  return { state: { ...state, revision: state.revision + 1, entries, settings, groups: groupNamesOf(entries, [...(state.groups || []), ...(backup.groups || [])]) }, counts };
}
