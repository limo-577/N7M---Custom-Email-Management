const test = require('node:test');
const assert = require('node:assert/strict');
const { EditSessions } = require('../electron/edit-sessions.cjs');
const entries = () => [{ id: 'a', email: 'a@example.com', password: '  secret  ', notes: 'original', tags: ['工作'] }, { id: 'b', email: 'b@example.com' }];
test('bulk authorization is bound to a sender, generation, selected IDs and expiry', () => {
  let time = 100; const store = new EditSessions({ now: () => time, ttl: 500 }); const original = entries();
  const { token } = store.create([original[0]], 1, 2), patches = [{ id: 'a', patch: { password: 'new' } }];
  assert.ok(store.validate(token, patches, original, 1, 2));
  assert.throws(() => store.validate(token, patches, original, 2, 2), /验证/);
  assert.throws(() => store.validate(token, [{ id: 'b', patch: { notes: 'wrong scope' } }], original, 1, 2));
  time = 600; assert.throws(() => store.validate(token, patches, original, 1, 2), /验证/); assert.equal(store.sessions.size, 0);
});
test('only edited fields conflict; new browser-poll revisions and unrelated notes remain mergeable', () => {
  const store = new EditSessions(), original = entries(), { token } = store.create(original, 1, 1);
  const current = entries(); current[0].notes = 'another window changed notes'; current[0].openedAt = Date.now();
  assert.ok(store.validate(token, [{ id: 'a', patch: { password: 'next' } }], current, 1, 1));
  assert.throws(() => store.validate(token, [{ id: 'a', patch: { notes: 'overwrite' } }], current, 1, 1), /其他窗口/);
  assert.equal(current[0].notes, 'another window changed notes');
});
test('revoking clears keyed baselines, replaced sessions and stale generations cannot be reused', () => {
  const store = new EditSessions(), original = entries(), first = store.create(original, 1, 1), key = store.sessions.get(first.token).key;
  const next = store.create(original, 1, 1); assert.ok(key.every(byte => byte === 0)); assert.equal(store.sessions.size, 1);
  assert.throws(() => store.validate(first.token, [], original, 1, 1), /验证/);
  assert.throws(() => store.validate(next.token, [], original, 1, 2), /验证/); assert.equal(store.sessions.size, 0);
});
test('metadata writes, duplicate patches and malformed values are rejected without exposing credentials', () => {
  const store = new EditSessions(), original = entries(), { token } = store.create(original, 1, 1);
  for (const patches of [
    [{ id: 'a', patch: { browserWindow: { hwnd: '1' } } }],
    [{ id: 'a', patch: { password: { value: '  secret  ' } } }],
    [{ id: 'a', patch: {} }, { id: 'a', patch: {} }],
  ]) assert.throws(() => store.validate(token, patches, original, 1, 1), error => !error.message.includes('secret'));
});
