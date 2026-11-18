import test from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNT_SORT_OPTIONS, sortAccounts, nextAccountSort, accountSortDirection } from '../src/account-view.mjs';

const ids = entries => entries.map(entry => entry.id);

test('sort choices cover original order and both directions for every supported account column', () => {
  assert.deepEqual(ACCOUNT_SORT_OPTIONS.map(option => option.value), [
    'original', 'browser-asc', 'browser-desc', 'email-asc', 'email-desc', 'notes-asc', 'notes-desc',
  ]);
  assert.ok(ACCOUNT_SORT_OPTIONS.every(option => typeof option.label === 'string' && option.label.trim()));
});

test('original and unknown sorts return a separate array without changing account objects or their order', () => {
  const entries = Object.freeze([
    Object.freeze({ id: 'b', email: 'b@example.com', notes: '  keep spacing  ' }),
    Object.freeze({ id: 'a', email: 'a@example.com', notes: '' }),
  ]);
  for (const sort of ['original', 'unknown', 'email', 'email-asc-extra', '', undefined, null]) {
    const result = sortAccounts(entries, sort);
    assert.notEqual(result, entries);
    assert.deepEqual(ids(result), ['b', 'a']);
    assert.equal(result[0], entries[0]); assert.equal(result[1], entries[1]);
  }
  assert.deepEqual(sortAccounts(undefined, 'notes-asc'), []);
  assert.equal(entries[0].notes, '  keep spacing  ');
});

test('browser ordering retains English browser order, stable ties and blanks last in both directions', () => {
  const entries = [
    { id: 'chrome-first', browser: 'Chrome' }, { id: 'edge', browser: 'Edge' },
    { id: 'empty', browser: '' }, { id: 'brave', browser: 'Brave' },
    { id: 'chrome-second', browser: ' chrome ' }, { id: 'firefox', browser: 'Firefox' },
    { id: 'system', browser: '系统默认' }, { id: 'missing' },
  ];
  assert.deepEqual(ids(sortAccounts(entries, 'browser-asc')), [
    'brave', 'chrome-first', 'chrome-second', 'edge', 'firefox', 'system', 'empty', 'missing',
  ]);
  assert.deepEqual(ids(sortAccounts(entries, 'browser-desc')), [
    'system', 'firefox', 'edge', 'chrome-first', 'chrome-second', 'brave', 'empty', 'missing',
  ]);
  assert.deepEqual(ids(entries), ['chrome-first', 'edge', 'empty', 'brave', 'chrome-second', 'firefox', 'system', 'missing']);
});

test('email sorting uses natural numbers and ignores case and edge whitespace without merging independent routes', () => {
  const entries = [
    { id: 'ten', email: 'user10@example.com', browser: 'Chrome', profile: 'Profile 1' },
    { id: 'two-chrome', email: '  User2@example.com ', browser: 'Chrome', profile: 'Profile 2' },
    { id: 'empty', email: ' \t ' },
    { id: 'two-firefox', email: 'USER2@example.com', browser: 'Firefox', profile: 'Work' },
    { id: 'one', email: 'user1@example.com', browser: 'Edge', profile: '' },
    { id: 'missing' },
  ];
  const before = JSON.stringify(entries);
  const asc = sortAccounts(entries, 'email-asc'), desc = sortAccounts(entries, 'email-desc');
  assert.deepEqual(ids(asc), ['one', 'two-chrome', 'two-firefox', 'ten', 'empty', 'missing']);
  assert.deepEqual(ids(desc), ['ten', 'two-chrome', 'two-firefox', 'one', 'empty', 'missing']);
  assert.equal(asc[1], entries[1]); assert.equal(asc[2], entries[3]);
  assert.equal(asc.length, entries.length);
  assert.equal(JSON.stringify(entries), before);
});

test('Chinese notes sort naturally in both directions while preserving blank notes at the end', () => {
  const entries = [
    { id: 'zhong', notes: '中转2' }, { id: 'bei-ten', notes: '北方10' },
    { id: 'empty', notes: '' }, { id: 'bei-two', notes: '  北方2  ' },
    { id: 'a', notes: '阿组1' }, { id: 'missing', notes: null }, { id: 'spaces', notes: ' \n ' },
  ];
  assert.deepEqual(ids(sortAccounts(entries, 'notes-asc')), ['a', 'bei-two', 'bei-ten', 'zhong', 'empty', 'missing', 'spaces']);
  assert.deepEqual(ids(sortAccounts(entries, 'notes-desc')), ['zhong', 'bei-ten', 'bei-two', 'a', 'empty', 'missing', 'spaces']);
  assert.equal(entries[3].notes, '  北方2  ');
});

test('case-equivalent notes stay stable across directions and zero is content rather than a blank note', () => {
  const entries = [
    { id: 'upper', notes: 'TASK 2' }, { id: 'lower', notes: ' task 2 ' },
    { id: 'ten', notes: 'Task 10' }, { id: 'blank', notes: undefined }, { id: 'zero', notes: 0 },
  ];
  assert.deepEqual(ids(sortAccounts(entries, 'notes-asc')), ['zero', 'upper', 'lower', 'ten', 'blank']);
  assert.deepEqual(ids(sortAccounts(entries, 'notes-desc')), ['ten', 'upper', 'lower', 'zero', 'blank']);
});

test('column headings cycle ascending, descending and original while changing columns starts ascending', () => {
  for (const field of ['browser', 'email', 'notes']) {
    const asc = nextAccountSort('original', field), desc = nextAccountSort(asc, field);
    assert.equal(asc, `${field}-asc`); assert.equal(desc, `${field}-desc`);
    assert.equal(nextAccountSort(desc, field), 'original');
    assert.equal(accountSortDirection(asc, field), 'ascending');
    assert.equal(accountSortDirection(desc, field), 'descending');
    assert.equal(accountSortDirection('original', field), 'none');
  }
  assert.equal(nextAccountSort('browser-desc', 'email'), 'email-asc');
  assert.equal(nextAccountSort('email-asc', 'notes'), 'notes-asc');
  assert.equal(nextAccountSort('invalid', 'browser'), 'browser-asc');
  assert.equal(nextAccountSort('notes-desc', 'unknown'), 'original');
  assert.equal(accountSortDirection('notes-desc', 'email'), 'none');
  assert.equal(accountSortDirection('notes-desc-extra', 'notes'), 'none');
  assert.equal(accountSortDirection(undefined, 'notes'), 'none');
  assert.equal(accountSortDirection(undefined, undefined), 'none');
});
