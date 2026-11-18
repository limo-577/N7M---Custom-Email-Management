import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeState } from '../src/model.mjs';
import { applyMutation, restoreBackup } from '../src/mutations.mjs';
const state = () => normalizeState({ entries: [
  { id: 'a', email: 'a@example.com', browser: 'Chrome', displayId: '001', password: '  original a  ', notes: 'a', group: '工作' },
  { id: 'b', email: 'b@example.com', browser: 'Firefox', displayId: '002', password: 'original b', notes: 'b' },
], settings: { cooldownHours: 24 }, groups: ['空组'] });
test('different per-row patches and email swaps save once without altering unrelated fields', () => {
  const before = state();
  const next = applyMutation(before, { type: 'update-many', patches: [
    { id: 'a', patch: { email: 'b@example.com', password: '  new exact a  ' } },
    { id: 'b', patch: { email: 'a@example.com', notes: 'changed b' } },
  ] });
  assert.equal(next.revision, before.revision + 1);
  assert.equal(next.entries[0].password, '  new exact a  ');
  assert.equal(next.entries[1].password, 'original b');
  assert.deepEqual(next.entries.map(entry => entry.email), ['b@example.com', 'a@example.com']);
  assert.equal(before.entries[0].email, 'a@example.com');
});
test('one invalid bulk row or duplicate account prevents every change', () => {
  const before = state(), serialized = JSON.stringify(before);
  for (const patches of [
    [{ id: 'a', patch: { notes: 'valid' } }, { id: 'b', patch: { totpSecret: 'invalid private seed' } }],
    [{ id: 'a', patch: { email: 'b@example.com', browser: 'Firefox' } }],
    [{ id: 'a', patch: { notes: 'first' } }, { id: 'a', patch: { notes: 'duplicate' } }],
    [{ id: 'a', patch: { launchUrl: 'javascript:alert(1)' } }],
  ]) assert.throws(() => applyMutation(before, { type: 'update-many', patches }));
  assert.equal(JSON.stringify(before), serialized);
});
test('encrypted restore fills missing credentials, preserves existing credentials and strips runtime identity from new accounts', () => {
  const before = state(); before.entries[1].password = '';
  const backup = normalizeState({ entries: [
    { id: 'foreign-a', email: 'A@example.com', browser: 'Chrome', password: 'backup a' },
    { id: 'foreign-b', email: 'b@example.com', browser: 'Firefox', password: ' backup b ' },
    { id: 'foreign-c', email: 'c@example.com', browser: 'Brave', displayId: '001', password: 'new c', browserWindow: { hwnd: '123' }, status: 'used', usedAt: 123, openedAt: 123 },
  ], settings: { cooldownHours: 12 }, groups: ['备份空组'] });
  const { state: restored, counts } = restoreBackup(before, backup, 'fill', true);
  assert.deepEqual(counts, { added: 1, updated: 1, skipped: 1 });
  assert.equal(restored.entries[0].password, '  original a  ');
  assert.equal(restored.entries[0].browser, 'Chrome');
  assert.equal(restored.entries[1].password, ' backup b ');
  assert.equal(restored.entries[2].displayId, '003');
  assert.equal(Object.hasOwn(restored.entries[2], 'browserWindow'), false);
  assert.equal(restored.entries[2].openedAt, null); assert.equal(restored.entries[2].status, 'available');
  assert.equal(restored.settings.cooldownHours, 12); assert.ok(restored.groups.includes('备份空组'));
});
test('restore requires explicit overwrite to replace matching secrets and retains active routes', () => {
  const before = state(), backup = normalizeState([{ email: 'a@example.com', browser: 'Chrome', password: 'replacement' }]);
  assert.equal(restoreBackup(before, backup, 'add').state.entries[0].password, '  original a  ');
  assert.equal(restoreBackup(before, backup, 'overwrite').state.entries[0].password, 'replacement');
  before.entries[0].browserWindow = { hwnd: '123' };
  const active = restoreBackup(before, backup, 'overwrite').state.entries[0];
  assert.equal(active.password, 'replacement');
  assert.deepEqual(active.browserWindow, { hwnd: '123' });
  const otherBrowser = normalizeState([{ email: 'a@example.com', browser: 'Edge', password: 'other browser' }]);
  const restored = restoreBackup(before, otherBrowser, 'overwrite');
  assert.deepEqual(restored.counts, { added: 1, updated: 0, skipped: 0 });
  assert.equal(restored.state.entries[0].browser, 'Chrome');
  assert.deepEqual(restored.state.entries[0].browserWindow, { hwnd: '123' });
  assert.equal(restored.state.entries[2].password, 'other browser');
  assert.equal(before.entries[0].password, '  original a  ');
});

test('same mailbox records can change independently and only a final complete identity collision is rejected', () => {
  const before = state();
  const next = applyMutation(before, { type: 'update-many', patches: [
    { id: 'a', patch: { email: 'shared label', profile: 'Profile 1', password: 'chrome secret' } },
    { id: 'b', patch: { email: 'shared label', profile: 'Work', password: 'firefox secret' } },
  ] });
  assert.deepEqual(next.entries.map(entry => entry.password), ['chrome secret', 'firefox secret']);
  const addedRoute = applyMutation(next, { type: 'import', entries: [
    { id: 'c', email: 'SHARED LABEL', browser: 'Chrome', profile: 'Profile 2', password: 'second chrome' },
  ] });
  assert.equal(addedRoute.entries.length, 3);
  assert.throws(() => applyMutation(addedRoute, { type: 'update', ids: ['c'], patch: { profile: '1' } }), /组合重复/);
  assert.throws(() => applyMutation(addedRoute, { type: 'update-many', patches: [
    { id: 'b', patch: { notes: 'do not save' } }, { id: 'c', patch: { profile: 'PROFILE 1' } },
  ] }), /组合重复/);
  assert.equal(addedRoute.entries[1].notes, 'b');
  assert.equal(addedRoute.entries[2].password, 'second chrome');
});

test('backup restoration matches credentials by all three identity fields regardless of incoming order or IDs', () => {
  const before = normalizeState({ entries: [
    { id: 'chrome-1', email: 'same mailbox', browser: 'Chrome', profile: 'Profile 1', password: '', notes: 'first' },
    { id: 'chrome-2', email: 'same mailbox', browser: 'Chrome', profile: 'Profile 2', password: '', notes: 'second' },
    { id: 'firefox', email: 'same mailbox', browser: 'Firefox', profile: 'Work', password: 'keep me' },
  ] });
  const backup = normalizeState({ entries: [
    { id: 'chrome-1', email: 'SAME MAILBOX', browser: 'Chrome', profile: 'Profile 2', password: 'secret two' },
    { id: 'chrome-2', email: 'same mailbox', browser: 'Chrome', profile: '1', password: 'secret one' },
    { id: 'firefox', email: 'same mailbox', browser: 'Firefox', profile: 'work', password: 'lowercase new', browserWindow: { hwnd: '999' } },
    { id: 'another-id', email: 'same mailbox', browser: 'Firefox', profile: 'Work', password: 'do not overwrite' },
  ] });
  const restored = restoreBackup(before, backup, 'fill');
  assert.deepEqual(restored.counts, { added: 1, updated: 2, skipped: 1 });
  assert.deepEqual(restored.state.entries.map(entry => entry.password), ['secret one', 'secret two', 'keep me', 'lowercase new']);
  assert.deepEqual(restored.state.entries.slice(0, 3).map(entry => entry.id), ['chrome-1', 'chrome-2', 'firefox']);
  assert.equal(new Set(restored.state.entries.map(entry => entry.id)).size, 4);
  assert.equal(Object.hasOwn(restored.state.entries[3], 'browserWindow'), false);
  assert.equal(restored.state.entries[0].profile, 'Profile 1');
  assert.deepEqual(before.entries.map(entry => entry.password), ['', '', 'keep me']);
});
