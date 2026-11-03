import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeState, normalizeEntry, normalizeTotpSecret, parseDelimited, rowsToEntries, mergeImport, issuesOf, effectiveStatus, exportCsv, webUrl } from '../src/model.mjs';
import { applyMutation } from '../src/mutations.mjs';
test('missing columns stay blank and retain position; no browser or display ID assignment', () => {
  const rows = rowsToEntries(parseDelimited('邮箱链接\t浏览器\tProfile\t编号\t启动网页\na@example.com\t\tProfile 2\t\thttps://example.com\nb@example.com\tEdge\t\t002\t'));
  assert.equal(rows[0].browser, ''); assert.equal(rows[0].displayId, ''); assert.equal(rows[0].profile, 'Profile 2');
  assert.deepEqual(issuesOf(rows[0]), ['缺少浏览器']);
  assert.equal(rows[1].profile, ''); assert.equal(rows[1].displayId, '002');
  assert.equal(rowsToEntries(parseDelimited('a@example.com,,003'))[0].browser, '');
});
test('CSV handles BOM, commas, escaped quotes, multiline notes and reordered headings', () => {
  const rows = rowsToEntries(parseDelimited('\uFEFF编号,邮箱链接,备注,浏览器\r\n001,a@example.com,"first, line\nsecond ""quote""",Chrome'));
  assert.equal(rows[0].displayId, '001'); assert.equal(rows[0].notes, 'first, line\nsecond "quote"');
  assert.throws(() => parseDelimited('a,"unclosed'), /引号/);
});
test('imports deduplicate existing and same-batch email case-insensitively', () => {
  const incoming = ['A@example.com', 'new@example.com', 'NEW@example.com', ''].map(email => normalizeEntry({ email }));
  const result = mergeImport([normalizeEntry({ email: 'a@example.com' })], incoming);
  assert.equal(result.added.length, 1); assert.equal(result.skipped, 2); assert.equal(result.invalid, 1); assert.equal(result.incomplete, 1);
});
test('old data retains IDs, timing and profile without inventing launch URLs', () => {
  const old = [{ id: 'old', email: 'a@example.com', displayId: '001', browser: 'Chrome', profile: 'Profile 43', status: 'used', usedAt: 1000 }];
  const state = normalizeState(old);
  assert.equal(state.entries[0].id, 'old'); assert.equal(state.entries[0].usedAt, 1000); assert.equal(state.entries[0].launchUrl, '');
  assert.equal(state.settings.cooldownHours, 24);
});
test('cooldown uses global value or account override and expires at exact boundary', () => {
  const e = normalizeEntry({ status: 'used', usedAt: 1000 });
  assert.equal(effectiveStatus(e, { cooldownHours: .5 }, 1800999), 'used');
  assert.equal(effectiveStatus(e, { cooldownHours: .5 }, 1801000), 'available');
  assert.equal(effectiveStatus({ ...e, cooldownHours: 1 }, { cooldownHours: .5 }, 1801000), 'used');
});
test('export uses display ID and computed status; round trip preserves fields', () => {
  const e = normalizeEntry({ id: 'internal', displayId: '001', email: 'a@example.com', browser: 'Edge', launchUrl: 'https://example.com', notes: 'a,"b"\nc', group: '工作', tags: ['a', 'b'], status: 'used', usedAt: 1000, cooldownHours: 1 });
  const csv = exportCsv([e], { cooldownHours: 24 }, 3601000);
  assert.ok(!csv.includes('internal')); assert.ok(csv.includes('"可用"'));
  const imported = rowsToEntries(parseDelimited(csv))[0];
  for (const key of ['displayId','email','notes','group','launchUrl','cooldownHours']) assert.equal(imported[key], e[key]);
  assert.deepEqual(imported.tags, e.tags); assert.equal(imported.status, 'available'); assert.equal(imported.usedAt, null);
  assert.ok(exportCsv([{ ...e, notes: '=1+1' }]).includes("'=1+1"));
});
test('only web protocols are allowed for launch URLs', () => {
  assert.equal(webUrl('example.com'), 'https://example.com/');
  for (const value of ['javascript:alert(1)','file:///C:/secret','https://user:pass@example.com']) assert.throws(() => webUrl(value));
});
test('patch operations preserve unrelated latest-window changes and validate duplicate edits', () => {
  let state = normalizeState([{ id: 'a', email: 'a@example.com' }, { id: 'b', email: 'b@example.com' }]);
  state = applyMutation(state, { type: 'update', ids: ['a'], patch: { notes: '窗口 A' } });
  state = applyMutation(state, { type: 'update', ids: ['a', 'b'], patch: { launchUrl: 'example.com', group: '工作' } });
  assert.equal(state.entries[0].notes, '窗口 A'); assert.equal(state.entries[1].launchUrl, 'https://example.com/');
  assert.throws(() => applyMutation(state, { type: 'update', ids: ['a'], patch: { email: 'B@example.com' } }), /重复/);
  assert.throws(() => applyMutation(state, { type: 'settings', cooldownHours: -1 }), /冷却/);
  assert.throws(() => applyMutation(state, { type: 'update', ids: ['a'], patch: { launchUrl: 'file:///etc' } }), /http/);
});
test('launch URL and display ID are optional while browser selection remains required', () => {
  assert.deepEqual(issuesOf(normalizeEntry({ email: 'a@example.com', browser: 'Chrome' })), []);
  assert.deepEqual(issuesOf(normalizeEntry({ email: 'a@example.com', browser: '' })), ['缺少浏览器']);
  assert.deepEqual(issuesOf(normalizeEntry({ email: 'a@example.com', browser: 'Firefox' })), ['浏览器类型待确认']);
  assert.deepEqual(issuesOf(normalizeEntry({ email: 'a@example.com', browser: 'Chrome', launchUrl: 'javascript:alert(1)' })), ['启动网址无效']);
});
test('credential normalization preserves password whitespace and canonicalizes supported TOTP input', () => {
  const password = '  exact password\twith spaces  ';
  const entry = normalizeEntry({ email: 'a@example.com', password, totpSecret: 'jbsw y3dp ehpk 3pxp' });
  assert.equal(entry.password, password);
  assert.equal(entry.totpSecret, 'JBSWY3DPEHPK3PXP');
  assert.equal(normalizeTotpSecret('otpauth://totp/N7M?secret=JBSWY3DPEHPK3PXP&issuer=N7M&algorithm=SHA1&digits=6&period=30'), 'JBSWY3DPEHPK3PXP');
  assert.equal(normalizeTotpSecret(''), '');
  for (const value of ['BAD-SECRET', 'TOO_SHORT', 'otpauth://hotp/N7M?secret=JBSWY3DPEHPK3PXP', 'otpauth://totp/N7M?secret=JBSWY3DPEHPK3PXP&digits=8', 'otpauth://totp/N7M?secret=JBSWY3DPEHPK3PXP&algorithm=SHA256', 'otpauth://totp/N7M?secret=JBSWY3DPEHPK3PXP&period=60']) assert.throws(() => normalizeTotpSecret(value), /TOTP|SHA1|验证/);
});
test('sanitized snapshots never acquire raw password or TOTP properties', () => {
  const snapshot = normalizeEntry({ id: 'a', email: 'a@example.com', hasPassword: true, hasTotp: true });
  assert.equal(Object.hasOwn(snapshot, 'password'), false); assert.equal(Object.hasOwn(snapshot, 'totpSecret'), false);
  assert.equal(snapshot.hasPassword, true); assert.equal(snapshot.hasTotp, true);
});
test('credential import accepts named headers and default CSV export excludes all secrets', () => {
  const password = '  do-not-trim  ';
  const rows = rowsToEntries(parseDelimited(`邮箱链接,浏览器,密码,TOTP密钥\na@example.com,Chrome,"${password}",JBSWY3DPEHPK3PXP`));
  assert.equal(rows[0].password, password); assert.equal(rows[0].totpSecret, 'JBSWY3DPEHPK3PXP');
  const csv = exportCsv(rows);
  assert.equal(csv.includes(password), false); assert.equal(csv.includes('JBSWY3DPEHPK3PXP'), false);
  assert.equal(csv.includes('"密码"'), false); assert.equal(csv.includes('"TOTP'), false);
});
test('credentials can be added and cleared without unrelated patches erasing them', () => {
  let state = normalizeState([{ id: 'a', email: 'a@example.com', browser: 'Chrome' }]);
  state = applyMutation(state, { type: 'update', ids: ['a'], patch: { password: ' secret ', totpSecret: 'jbswy3dpehpk3pxp' } });
  state = applyMutation(state, { type: 'update', ids: ['a'], patch: { notes: 'only notes' } });
  assert.equal(state.entries[0].password, ' secret '); assert.equal(state.entries[0].totpSecret, 'JBSWY3DPEHPK3PXP');
  assert.throws(() => applyMutation(state, { type: 'update', ids: ['a'], patch: { totpSecret: 'not-a-key' } }), /TOTP/);
  state = applyMutation(state, { type: 'update', ids: ['a'], patch: { password: '', totpSecret: '' } });
  assert.equal(state.entries[0].password, ''); assert.equal(state.entries[0].totpSecret, '');
});

test('persistent group catalog infers legacy memberships and keeps empty groups across normalization', () => {
  const legacy = normalizeState([{ id: 'a', email: 'a@example.com', group: ' 历史分组 ' }]);
  assert.deepEqual(legacy.groups, ['历史分组']);
  const merged = normalizeState({ entries: legacy.entries, groups: ['空分组', ' 空分组 ', '', '历史分组'] });
  assert.deepEqual(merged.groups, ['空分组', '历史分组']);
  const added = applyMutation(merged, { type: 'group-add', name: ' 新分组 ' });
  assert.deepEqual(added.groups, ['空分组', '历史分组', '新分组']);
  const restored = normalizeState(JSON.parse(JSON.stringify(added)));
  assert.deepEqual(restored.groups, added.groups);
  assert.equal(restored.entries.length, 1);
  const deletedLastAccount = applyMutation(restored, { type: 'delete', ids: ['a'] });
  assert.equal(deletedLastAccount.entries.length, 0);
  assert.deepEqual(normalizeState(deletedLastAccount).groups, added.groups);
});

test('deleting a group removes memberships without deleting accounts or credentials', () => {
  const state = normalizeState({ entries: [
    { id: 'a', email: 'a@example.com', group: '工作', password: ' secret ', totpSecret: 'JBSWY3DPEHPK3PXP', status: 'used', usedAt: 1000 },
    { id: 'b', email: 'b@example.com', group: '工作', notes: '保留备注' },
    { id: 'c', email: 'c@example.com', group: '私人' }
  ], groups: ['工作', '私人', '空分组'] });
  const deleted = applyMutation(state, { type: 'group-delete', name: '工作' });
  assert.deepEqual(deleted.groups, ['私人', '空分组']);
  assert.equal(deleted.entries.length, 3);
  assert.deepEqual(deleted.entries.map(entry => entry.group), ['', '', '私人']);
  assert.equal(deleted.entries[0].password, ' secret ');
  assert.equal(deleted.entries[0].totpSecret, 'JBSWY3DPEHPK3PXP');
  assert.equal(deleted.entries[0].usedAt, 1000); assert.equal(deleted.entries[0].status, 'used');
  assert.equal(deleted.entries[1].notes, '保留备注');
  assert.equal(state.entries[0].group, '工作');
  assert.equal(deleted.revision, state.revision + 1);
  assert.deepEqual(normalizeState(deleted).groups, ['私人', '空分组']);
});

test('new assigned and imported memberships register groups while unrelated edits retain the catalog', () => {
  let state = normalizeState({ entries: [{ id: 'a', email: 'a@example.com' }], groups: ['空分组'] });
  state = applyMutation(state, { type: 'update', ids: ['a'], patch: { group: '工作' } });
  assert.deepEqual(state.groups, ['空分组', '工作']);
  state = applyMutation(state, { type: 'import', entries: [
    { id: 'b', email: 'b@example.com', group: '导入分组' },
    { id: 'duplicate', email: 'A@example.com', group: '不应注册' }
  ] });
  assert.deepEqual(state.groups, ['空分组', '工作', '导入分组']);
  state = applyMutation(state, { type: 'update', ids: ['a'], patch: { group: '', notes: '独立修改' } });
  assert.deepEqual(state.groups, ['空分组', '工作', '导入分组']);
  const renamed = applyMutation(state, { type: 'group-rename', name: '导入分组', newName: '重命名' });
  assert.deepEqual(renamed.groups, ['空分组', '工作', '重命名']);
  assert.equal(renamed.entries[1].group, '重命名');
});

test('group management validates new names and rejects duplicate groups without losing data', () => {
  const state = normalizeState({ entries: [], groups: ['工作'] });
  for (const name of ['', '   ', '__none', 'x'.repeat(81)]) assert.throws(() => applyMutation(state, { type: 'group-add', name }), /分组/);
  assert.throws(() => applyMutation(state, { type: 'group-add', name: ' 工作 ' }), /已存在/);
  assert.throws(() => applyMutation(state, { type: 'group-delete', name: '不存在' }), /不存在/);
  assert.deepEqual(state.groups, ['工作']);
});
