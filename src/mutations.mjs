import { normalizeEntry, BROWSERS, webUrl, groupNamesOf, text } from './model.mjs';
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
    const seen = new Set(entries.map(e => e.email.toLowerCase()));
    const added = (operation.entries || []).map(normalizeEntry).filter(e => {
      if (!e.email || seen.has(e.email.toLowerCase())) return false;
      seen.add(e.email.toLowerCase()); return true;
    });
    entries = [...entries, ...added];
  } else if (operation.type === 'update') {
    const patch = {};
    for (const key of ['email', 'browser', 'profile', 'displayId', 'launchUrl', 'notes', 'group', 'tags', 'cooldownHours', 'password', 'totpSecret']) {
      if (Object.hasOwn(operation.patch, key)) patch[key] = operation.patch[key];
    }
    if (Object.hasOwn(patch, 'browser') && patch.browser && !BROWSERS.includes(patch.browser)) throw new Error('请选择支持的浏览器');
    if (patch.launchUrl) patch.launchUrl = webUrl(patch.launchUrl);
    if (patch.cooldownHours != null && patch.cooldownHours !== '' && (!Number.isFinite(Number(patch.cooldownHours)) || Number(patch.cooldownHours) <= 0 || Number(patch.cooldownHours) > 8760)) throw new Error('冷却小时必须大于 0 且不超过 8760');
    entries = entries.map(e => ids.has(e.id) ? normalizeEntry({ ...e, ...patch }) : e);
    const seen = new Set();
    for (const e of entries) {
      if (!e.email) throw new Error('邮箱资料不能为空');
      if (seen.has(e.email.toLowerCase())) throw new Error('邮箱资料重复，请使用其他邮箱');
      seen.add(e.email.toLowerCase());
    }
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
  return { ...state, revision: state.revision + 1, entries, settings, groups: groupNamesOf(entries, groups) };
}
