'use strict';
// Only authenticated backup plaintext is passed to these helpers. Window
// handles and machine-local migration metadata never leave the active vault.
const BACKUP_PAYLOAD = 'N7M-BACKUP-PAYLOAD';
const MAX_BACKUP_ENTRIES = 100000;
const EDITABLE_FIELDS = ['id', 'email', 'browser', 'profile', 'displayId', 'launchUrl', 'notes', 'group', 'tags', 'cooldownHours', 'password', 'totpSecret'];
function selectedEntries(state, ids) {
  if (!Array.isArray(state.entries) || state.entries.length > MAX_BACKUP_ENTRIES) throw new Error('账号数量超出备份或编辑限制');
  if (ids == null) return state.entries;
  if (!Array.isArray(ids) || !ids.length || ids.length > MAX_BACKUP_ENTRIES || ids.some(id => typeof id !== 'string' || !id || id.length > 256)) throw new Error('账号选择无效');
  const selected = new Set(ids), entries = state.entries.filter(entry => selected.has(entry.id));
  if (entries.length !== selected.size) throw new Error('所选账号已变化，请刷新后重试');
  return entries;
}
function editableEntry(entry) {
  return Object.fromEntries(EDITABLE_FIELDS.filter(field => Object.hasOwn(entry, field)).map(field => [field, field === 'tags' && Array.isArray(entry.tags) ? [...entry.tags] : entry[field]]));
}
function buildBackupPayload(state, ids) {
  const entries = selectedEntries(state, ids);
  if (!entries.length) throw new Error('没有可备份的账号');
  const groups = ids == null ? [...(state.groups || [])] : [...new Set(entries.map(entry => entry.group).filter(Boolean))];
  return { format: BACKUP_PAYLOAD, version: 1, createdAt: new Date().toISOString(), scope: ids == null ? 'all' : 'selected',
    state: { version: 2, revision: 0, groups, settings: { cooldownHours: state.settings?.cooldownHours ?? 24 },
      entries: entries.map(entry => ({ ...editableEntry(entry), status: 'available', usedAt: null, openedAt: null })) } };
}
function readBackupPayload(payload, normalizeState) {
  const invalid = () => { throw new Error('备份资料结构无效或超出读取限制'); };
  if (!payload || payload.format !== BACKUP_PAYLOAD || payload.version !== 1 || !payload.state || !Array.isArray(payload.state.entries) || payload.state.entries.length > MAX_BACKUP_ENTRIES || !['all', 'selected'].includes(payload.scope)) invalid();
  const state = payload.state;
  if (!Array.isArray(state.groups) || state.groups.length > MAX_BACKUP_ENTRIES || state.groups.some(group => typeof group !== 'string' || group.length > 1048576)) invalid();
  const cooldownHours = state.settings?.cooldownHours;
  if (!Number.isFinite(cooldownHours) || cooldownHours <= 0 || cooldownHours > 8760) invalid();
  const entries = state.entries.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) invalid();
    for (const key of EDITABLE_FIELDS) {
      const value = entry[key];
      if (value == null) continue;
      if (key === 'tags') { if (!Array.isArray(value) || value.length > 10000 || value.some(tag => typeof tag !== 'string' || tag.length > 1048576)) invalid(); }
      else if (key === 'cooldownHours') { if (!Number.isFinite(value) || value <= 0 || value > 8760) invalid(); }
      else if (typeof value !== 'string' || value.length > 1048576) invalid();
    }
    if (typeof entry.id !== 'string' || !entry.id || entry.id.length > 256 || typeof entry.email !== 'string' || !entry.email.trim()) invalid();
    return { ...editableEntry(entry), status: 'available', usedAt: null, openedAt: null };
  });
  try { return normalizeState({ version: 2, revision: 0, groups: [...state.groups], settings: { cooldownHours }, entries }); }
  catch { invalid(); }
}
module.exports = { selectedEntries, editableEntry, buildBackupPayload, readBackupPayload, MAX_BACKUP_ENTRIES };
