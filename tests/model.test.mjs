import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeState, normalizeEntry, numberMissingEntries, normalizeTotpSecret, parseDelimited, rowsToEntries, mergeImport, issuesOf, effectiveStatus, exportCsv, webUrl, browserNameOf, profileIssueOf, accountKey } from '../src/model.mjs';
import { applyMutation } from '../src/mutations.mjs';
test('literal plus Profile names survive import, editing and export without selecting the space-named directory', () => {
  for (const browser of ['Chrome', 'Edge', 'Brave', 'Firefox']) {
    const entry = normalizeEntry({ id: 'plus', email: 'plus@example.com', browser, profile: 'Profile+21' });
    assert.equal(entry.profile, 'Profile+21'); assert.deepEqual(issuesOf(entry), []);
    const named = normalizeEntry({ ...entry, profile: 'Work+Team' });
    assert.equal(named.profile, 'Work+Team'); assert.deepEqual(issuesOf(named), []);
    assert.equal(rowsToEntries(parseDelimited(exportCsv([entry])))[0].profile, 'Profile+21');
    const state = normalizeState([{ ...entry, profile: 'Profile 21' }]);
    assert.equal(applyMutation(state, { type: 'update', ids: ['plus'], patch: { profile: 'Profile+21' } }).entries[0].profile, 'Profile+21');
    assert.equal(applyMutation(state, { type: 'update-many', patches: [{ id: 'plus', patch: { profile: 'Profile+21' } }] }).entries[0].profile, 'Profile+21');
  }
  const [entry] = rowsToEntries(parseDelimited('plus@example.com\tBrave\tProfile+21'));
  assert.equal(entry.profile, 'Profile+21'); assert.equal(entry.displayId, '');
});

test('Firefox aliases and profile names are accepted without treating them as Chromium directory names', () => {
  for (const browser of ['Firefox', 'firefox', 'Mozilla Firefox', '火狐', '火狐浏览器']) {
    const entry = normalizeEntry({ email: 'ff@example.com', browser, profile: '工作 (Mail).1' });
    assert.equal(browserNameOf(browser), 'Firefox'); assert.equal(entry.browser, 'Firefox');
    assert.equal(entry.profile, '工作 (Mail).1'); assert.deepEqual(issuesOf(entry), []);
  }
  for (const profile of ['default-release', '43', '工作 账号', 'Work.Profile (Mail)', '']) assert.equal(profileIssueOf('Firefox', profile), '');
  for (const profile of ['C:\\private', '../private', '--headless', 'private\nprofile', 'private"profile']) assert.match(profileIssueOf('Firefox', profile), /Firefox Profile/);
  assert.match(profileIssueOf('Chrome', '工作 (Mail).1'), /Profile/);
});
test('parsing keeps missing columns blank until saving assigns display IDs; browser stays unassigned', () => {
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

test('account identity uses mailbox, canonical browser and the actual profile while accepting partial mailbox labels', () => {
  const key = (browser, profile, email = '  Work label  ') => accountKey({ email, browser, profile });
  assert.equal(key('chrome', '43'), key('Chrome', 'PROFILE 43', 'work LABEL'));
  assert.equal(key('火狐浏览器', '工作账号'), key('Firefox', '工作账号'));
  assert.notEqual(key('Chrome', 'Profile+21'), key('Chrome', 'Profile 21'));
  assert.notEqual(key('Chrome', ''), key('Chrome', 'Default'));
  assert.notEqual(key('Chrome', 'Profile 1'), key('Edge', 'Profile 1'));
  assert.notEqual(key('Firefox', 'Work'), key('Firefox', 'work'));
  assert.notEqual(key('Firefox', '43'), key('Firefox', 'Profile 43'));
  const result = mergeImport([], [normalizeEntry({ email: '  业务一  ', browser: 'Firefox', profile: 'Work' })]);
  assert.equal(result.added[0].email, '业务一');
  assert.equal(result.invalid, 0);
});

test('imports retain separate browser routes and skip only matching three-part identities across batches', () => {
  const existing = [normalizeEntry({ email: 'Work', browser: 'Chrome', profile: 'Profile 43', password: 'existing' })];
  const incoming = [
    { email: ' work ', browser: 'chrome', profile: '43', password: 'ignored' },
    { email: 'Work', browser: 'Chrome', profile: 'Profile 44', password: 'profile 44' },
    { email: 'WORK', browser: 'Edge', profile: 'Profile 43', password: 'edge' },
    { email: 'work', browser: 'Edge', profile: '43', password: 'ignored too' },
    { email: 'Work', browser: 'Chrome', profile: '', password: 'blank profile' },
  ].map(normalizeEntry);
  const result = mergeImport(existing, incoming);
  assert.equal(result.skipped, 2);
  assert.deepEqual(result.added.map(entry => entry.password), ['profile 44', 'edge', 'blank profile']);
  assert.equal(existing[0].password, 'existing');
});

test('imports keep independent internal IDs and credentials when incoming routes reuse an existing ID', () => {
  const before = normalizeState([{ id: 'same-id', email: 'partial', browser: 'Chrome', profile: '1', password: 'one' }]);
  const next = applyMutation(before, { type: 'import', entries: [
    { id: 'same-id', email: 'partial', browser: 'Chrome', profile: '2', password: 'two' },
    { id: 'same-id', email: 'partial', browser: 'Firefox', profile: 'Work', password: 'three' },
    { id: 'unique-id', email: 'partial', browser: 'Edge', profile: '2', password: 'four' },
  ] });
  assert.equal(new Set(next.entries.map(entry => entry.id)).size, 4);
  assert.equal(next.entries[0].id, 'same-id');
  assert.equal(next.entries[3].id, 'unique-id');
  assert.deepEqual(next.entries.map(entry => entry.password), ['one', 'two', 'three', 'four']);
  assert.deepEqual(next.entries.map(entry => entry.displayId), ['001', '002', '003', '004']);
  assert.equal(before.entries.length, 1);
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
  assert.deepEqual(issuesOf(normalizeEntry({ email: 'a@example.com', browser: 'UnsupportedBrowser' })), ['浏览器类型待确认']);
  assert.deepEqual(issuesOf(normalizeEntry({ email: 'a@example.com', browser: 'Chrome', launchUrl: 'javascript:alert(1)' })), ['启动网址无效']);
});
test('unsupported Profile characters flag supported browser accounts as incomplete before launch', () => {
  for (const browser of ['Chrome', 'Edge', 'Brave']) {
    for (const profile of ['Profile 43', 'Default', '43', 'work_profile-2', '']) {
      assert.deepEqual(issuesOf(normalizeEntry({ browser, profile })), []);
    }
    for (const profile of ['Profile\n43', 'Profile 1" --argument', 'C:\\Profiles\\Default', '../Default']) {
      assert.deepEqual(issuesOf(normalizeEntry({ browser, profile })), ['Profile 格式无效']);
    }
  }
  // The system handler does not receive Profile arguments. Missing or unknown
  // browser choices keep their existing, actionable browser-only issue.
  for (const [browser, expected] of [['系统默认', []], ['', ['缺少浏览器']], ['Unknown', ['浏览器类型待确认']]]) {
    assert.deepEqual(issuesOf(normalizeEntry({ browser, profile: 'C:\\Profiles\\Default' })), expected);
  }
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

test('missing IDs fill in list order above the largest numeric ID while existing gaps and custom IDs stay fixed', () => {
  const entries = [
    { id: 'a', displayId: '002' }, { id: 'b', displayId: '' },
    { id: 'c', displayId: 'manual-A' }, { id: 'd', displayId: '0009' },
    { id: 'e' }, { id: 'f', displayId: '1e10' }
  ];
  const result = numberMissingEntries(entries);
  assert.deepEqual(result.map(entry => entry.displayId), ['002', '0010', 'manual-A', '0009', '0011', '1e10']);
  assert.equal(entries[1].displayId, ''); assert.equal(Object.hasOwn(entries[4], 'displayId'), false);
  assert.equal(result[0], entries[0]); assert.notEqual(result[1], entries[1]);
  assert.equal(numberMissingEntries(result), result);
  const complete = entries.slice(0, 1);
  assert.equal(numberMissingEntries(complete), complete);
});

test('automatic IDs start at 001 and increment precisely above numeric IDs beyond Number safe integer range', () => {
  assert.deepEqual(numberMissingEntries([{ displayId: '' }, { displayId: '' }]).map(entry => entry.displayId), ['001', '002']);
  const result = numberMissingEntries([{ displayId: '99999999999999999999' }, { displayId: '' }, { displayId: '' }]);
  assert.deepEqual(result.map(entry => entry.displayId), ['99999999999999999999', '100000000000000000000', '100000000000000000001']);
});

test('saving multiple import batches assigns sequential IDs after deduplication and respects explicit incoming numeric IDs', () => {
  let state = normalizeState([{ id: 'old', email: 'old@example.com', displayId: '004', browser: 'Chrome' }]);
  state = applyMutation(state, { type: 'import', entries: [
    { id: 'duplicate', email: 'OLD@example.com', browser: 'Chrome', displayId: '999' },
    { id: 'a', email: 'a@example.com', browser: '' },
    { id: 'b', email: 'b@example.com', displayId: '010', browser: 'Edge' },
    { id: 'same-batch-duplicate', email: 'A@example.com' },
    { id: 'c', email: 'c@example.com' }
  ] });
  assert.deepEqual(state.entries.map(entry => entry.displayId), ['004', '011', '010', '012']);
  assert.equal(state.entries[1].browser, '');
  state = applyMutation(state, { type: 'import', entries: [{ id: 'd', email: 'd@example.com' }] });
  assert.deepEqual(state.entries.map(entry => entry.displayId), ['004', '011', '010', '012', '013']);
  state = applyMutation(state, { type: 'delete', ids: ['a'] });
  assert.deepEqual(state.entries.map(entry => entry.displayId), ['004', '010', '012', '013']);
  state = applyMutation(state, { type: 'import', entries: [{ id: 'e', email: 'e@example.com' }] });
  assert.equal(state.entries.at(-1).displayId, '014');
});

test('old blank IDs can be migrated separately and clearing an edited ID allocates after the current maximum', () => {
  const old = normalizeState([{ id: 'a', email: 'a@example.com' }, { id: 'b', email: 'b@example.com', displayId: '005' }]);
  assert.equal(old.entries[0].displayId, '');
  const migrated = numberMissingEntries(old.entries);
  assert.deepEqual(migrated.map(entry => entry.displayId), ['006', '005']);
  assert.equal(old.entries[0].displayId, '');
  const edited = applyMutation({ ...old, entries: migrated }, { type: 'update', ids: ['b'], patch: { displayId: '' } });
  assert.deepEqual(edited.entries.map(entry => entry.displayId), ['006', '007']);
  const manual = applyMutation(edited, { type: 'update', ids: ['b'], patch: { displayId: 'custom-7' } });
  assert.equal(manual.entries[1].displayId, 'custom-7');
});

test('opened markers normalize independently of cooling and survive state serialization', () => {
  assert.equal(normalizeEntry({ status: 'used', usedAt: 1234 }).openedAt, null);
  for (const openedAt of [undefined, null, 0, -1, Infinity, NaN, 'bad']) assert.equal(normalizeEntry({ openedAt }).openedAt, null);
  const state = normalizeState([{ id: 'a', email: 'a@example.com', openedAt: '1234' }]);
  assert.equal(state.entries[0].openedAt, 1234);
  assert.equal(normalizeState(JSON.parse(JSON.stringify(state))).entries[0].openedAt, 1234);
});

test('resetting cooldown and editing ordinary account fields preserve opened markers; browser and profile changes clear them', () => {
  const original = normalizeState([{ id: 'a', email: 'a@example.com', browser: 'Chrome', profile: 'Profile 1',
    openedAt: 1234, status: 'used', usedAt: 1234 }]);
  const reset = applyMutation(original, { type: 'reset', ids: ['a'] });
  assert.equal(reset.entries[0].openedAt, 1234); assert.equal(reset.entries[0].usedAt, null);
  const edited = applyMutation(reset, { type: 'update', ids: ['a'], patch: {
    notes: 'new notes', group: '工作', password: ' private ', launchUrl: 'example.com', browser: 'Chrome', profile: 'Profile 1', openedAt: 9999
  } });
  assert.equal(edited.entries[0].openedAt, 1234);
  const browserChanged = applyMutation(edited, { type: 'update', ids: ['a'], patch: { browser: 'Edge' } });
  assert.equal(browserChanged.entries[0].openedAt, null);
  const profileChanged = applyMutation(edited, { type: 'update', ids: ['a'], patch: { profile: 'Profile 2' } });
  assert.equal(profileChanged.entries[0].openedAt, null);
  assert.equal(original.entries[0].openedAt, 1234);
});
