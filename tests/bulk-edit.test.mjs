import test from 'node:test';
import assert from 'node:assert/strict';
import { applyBulkPaste, generateBulkPatches, makeBulkDrafts, parseGridClipboard } from '../src/bulk-edit.mjs';

const secret = 'JBSWY3DPEHPK3PXP';
const account = (id, email, extra = {}) => ({ id, email, browser: 'Chrome', profile: 'Profile 1', displayId: id,
  launchUrl: '', notes: '', group: '', tags: [], cooldownHours: null, password: '', totpSecret: '', ...extra });

test('bulk editing accepts plus Profile names while protecting a different opened configuration', () => {
  const original = [account('plus', 'plus@example.com', { browser: 'Brave', profile: 'Profile 21' })];
  const drafts = makeBulkDrafts(original); drafts[0].profile = 'Profile+21';
  const result = generateBulkPatches(original, drafts);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.patches, [{ id: 'plus', patch: { profile: 'Profile+21' } }]);
  const blocked = generateBulkPatches(original, drafts, [{ ...original[0], browserWindow: { hwnd: '123' } }]);
  assert.deepEqual(blocked.errors.map(error => error.key), ['profile']);
  assert.equal(blocked.patches.length, 0);
});

test('per-row bulk patches contain only changed editable fields and preserve exact password characters', () => {
  const original = [account('001', 'a@example.com', { password: 'unchanged', totpSecret: secret, browserWindow: { hwnd: '123' } }), account('002', 'b@example.com')];
  const rows = makeBulkDrafts(original);
  rows[0].notes = ' 工作备注 '; rows[1].password = '  password\twith\nspacing  ';
  const result = generateBulkPatches(original, rows);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.patches, [{ id: '001', patch: { notes: '工作备注' } }, { id: '002', patch: { password: '  password\twith\nspacing  ' } }]);
  assert.equal(result.changedRows, 2); assert.equal(result.changedFields, 2);
  assert.equal(original[0].notes, '');
  assert.equal(Object.hasOwn(result.patches[0].patch, 'password'), false);
  assert.equal(Object.hasOwn(result.patches[0].patch, 'browserWindow'), false);
});

test('atomic email swaps are allowed while collisions within or outside the edit scope are rejected', () => {
  const original = [account('001', 'a@example.com'), account('002', 'b@example.com')];
  const rows = makeBulkDrafts(original); rows[0].email = 'b@example.com'; rows[1].email = 'a@example.com';
  assert.deepEqual(generateBulkPatches(original, rows).errors, []);
  rows[0].email = 'A@example.com';
  assert.deepEqual(generateBulkPatches(original, rows).errors.map(error => error.row), [0, 1]);
  rows[0].email = 'outside@example.com'; rows[1].email = 'b@example.com';
  const result = generateBulkPatches(original, rows, [...original, account('003', 'OUTSIDE@example.com')]);
  assert.deepEqual(result.errors.map(error => [error.row, error.key]), [[0, 'email']]);
});

test('bulk collision checks use the final browser and profile together with the mailbox', () => {
  const original = [
    account('001', 'shared label', { profile: 'Profile 1' }),
    account('002', 'shared label', { browser: 'Firefox', profile: 'Work' }),
  ];
  const rows = makeBulkDrafts(original);
  rows[1].browser = 'Chrome'; rows[1].profile = '2';
  assert.deepEqual(generateBulkPatches(original, rows).errors, []);
  rows[1].profile = '1';
  assert.deepEqual(generateBulkPatches(original, rows).errors.map(error => error.row), [0, 1]);
  rows[1].profile = 'Profile+1';
  assert.deepEqual(generateBulkPatches(original, rows).errors, []);
  const outside = [...original, account('003', 'SHARED LABEL', { profile: 'Profile 2' })];
  rows[1].profile = 'PROFILE 2';
  assert.deepEqual(generateBulkPatches(original, rows, outside).errors.map(error => [error.row, error.key]), [[1, 'email']]);
  rows[1].browser = 'Firefox'; rows[1].profile = 'work';
  assert.deepEqual(generateBulkPatches(original, rows, outside).errors, []);
});

test('rectangular editing paste preserves account identity and empty cells and refuses the whole invalid rectangle', () => {
  const rows = makeBulkDrafts([account('001', 'a@example.com'), account('002', 'b@example.com')]);
  const matrix = parseGridClipboard('changed@example.com\tEdge\tDefault\t\r\nb@example.com\tFirefox\t工作账号\t');
  const next = applyBulkPaste(rows, 0, 0, matrix);
  assert.equal(next[0].id, '001'); assert.equal(next[1].id, '002'); assert.equal(next[0].displayId, '');
  assert.equal(next[1].profile, '工作账号'); assert.equal(rows[0].email, 'a@example.com');
  assert.throws(() => applyBulkPaste(rows, 1, 0, matrix), /超出/);
  assert.throws(() => applyBulkPaste(rows, 0, 10, [['one', 'two']]), /超出/);
  assert.throws(() => applyBulkPaste(rows, 0, 0, [['changed@example.com', 'Firefox']], (_row, key) => key === 'browser'), /已打开/);
  assert.equal(rows[0].email, 'a@example.com');
  const passthrough = applyBulkPaste(rows, 0, 1, [['Chrome', 'Profile 1']], (row, key, value) => value !== rows[row][key]);
  assert.equal(passthrough[0].browser, 'Chrome');
});

test('invalid secrets and other edited fields report row-local errors without echoing secret values', () => {
  const original = [account('001', 'a@example.com'), account('002', 'b@example.com')], rows = makeBulkDrafts(original);
  rows[0].totpSecret = 'private-otpauth-secret'; rows[0].launchUrl = 'https://user:private-password@example.com'; rows[1].cooldownHours = '0';
  const result = generateBulkPatches(original, rows);
  assert.deepEqual(result.errors.map(error => error.key).sort(), ['cooldownHours', 'launchUrl', 'totpSecret']);
  assert.equal(JSON.stringify(result.errors).includes('private'), false);
  assert.equal(JSON.stringify(result.errors).includes('password@example'), false);
});

test('immutable account IDs and complete edit scope cannot be changed by row replacement, insertion or removal', () => {
  const original = [account('001', 'a@example.com')], rows = makeBulkDrafts(original);
  assert.throws(() => generateBulkPatches(original, []), /会话/);
  assert.throws(() => generateBulkPatches(original, [...rows, { ...rows[0], id: '002' }]), /会话/);
  assert.throws(() => generateBulkPatches(original, [{ ...rows[0], id: 'forged' }]), /会话/);
  const deleted = generateBulkPatches(original, rows, [account('other', 'outside@example.com')]);
  assert.match(deleted.errors[0].message, /已删除/);
});

test('active browser routing fields stay protected while notes and passwords remain editable', () => {
  const original = [account('001', 'a@example.com', { browserWindow: { hwnd: '123' } })], rows = makeBulkDrafts(original);
  rows[0].profile = 'Profile 2'; rows[0].password = 'new';
  const result = generateBulkPatches(original, rows);
  assert.deepEqual(result.errors.map(error => error.key), ['profile']);
  assert.equal(Object.hasOwn(result.patches[0].patch, 'profile'), false);
  assert.equal(result.patches[0].patch.password, 'new');
  // Live observations may confirm the browser was closed during editing.
  const live = [{ ...original[0], browserWindow: null }];
  assert.deepEqual(generateBulkPatches(original, rows, live).errors, []);
});

test('normalization avoids no-op writes and accepts Firefox names without altering passwords', () => {
  const original = [account('001', 'a@example.com', { browser: 'Firefox', profile: '工作账号', tags: ['工作', '常用'], cooldownHours: 0.5 })];
  const rows = makeBulkDrafts(original);
  rows[0].browser = '火狐浏览器'; rows[0].tags = '工作，常用'; rows[0].cooldownHours = '0.50'; rows[0].email = ' a@example.com ';
  assert.deepEqual(generateBulkPatches(original, rows).patches, []);
  rows[0].profile = '另一个 Firefox 账号';
  const result = generateBulkPatches(original, rows);
  assert.deepEqual(result.errors, []); assert.deepEqual(result.patches[0].patch, { profile: '另一个 Firefox 账号' });
});

test('clearing saved credentials is explicit and absent snapshot secrets never become invented patches', () => {
  const original = [account('001', 'a@example.com', { password: 'saved', totpSecret: secret }), { id: '002', email: 'b@example.com', browser: '' }];
  const rows = makeBulkDrafts(original); rows[0].password = ''; rows[0].totpSecret = ''; rows[1].notes = 'pending browser';
  const result = generateBulkPatches(original, rows);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.patches, [{ id: '001', patch: { password: '', totpSecret: '' } }, { id: '002', patch: { notes: 'pending browser' } }]);
});

test('unchanged incomplete legacy routing or URL does not prevent unrelated credential edits', () => {
  const original = [account('001', 'a@example.com', { browser: 'Legacy Browser', profile: 'C:\\legacy\\path', launchUrl: 'invalid://old' })];
  const rows = makeBulkDrafts(original); rows[0].password = 'new password';
  const result = generateBulkPatches(original, rows);
  assert.deepEqual(result.errors, []); assert.deepEqual(result.patches, [{ id: '001', patch: { password: 'new password' } }]);
});
