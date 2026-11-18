import test from 'node:test';
import assert from 'node:assert/strict';
import { blankBatchRow, parseGridClipboard, applyGridPaste, validateBatchRows, MAX_BATCH_ROWS, BATCH_COLUMNS, BATCH_ENTRY_COLUMNS } from '../src/batch-entry.mjs';

test('compact entry columns paste only the seven visible fields and preserve hidden defaults', () => {
  assert.deepEqual(BATCH_ENTRY_COLUMNS.map(({ key, width }) => [key, width]), [
    ['email', 150], ['browser', 80], ['profile', 80], ['notes', 80], ['group', 80], ['password', 80], ['totpSecret', 80],
  ]);
  assert.equal(BATCH_COLUMNS.length, 11);
  const first = { ...blankBatchRow(), displayId: 'manual', launchUrl: 'https://example.com', tags: 'saved', cooldownHours: '12' };
  const rows = applyGridPaste([first], 0, 0, [['partial', 'Chrome', 'Profile+21', 'business note', 'work', ' exact password ', 'JBSWY3DPEHPK3PXP']], BATCH_ENTRY_COLUMNS);
  assert.equal(rows[0].notes, 'business note');
  assert.equal(rows[0].group, 'work');
  assert.equal(rows[0].password, ' exact password ');
  assert.equal(rows[0].totpSecret, 'JBSWY3DPEHPK3PXP');
  for (const key of ['displayId', 'launchUrl', 'tags', 'cooldownHours']) assert.equal(rows[0][key], first[key]);
  const extended = applyGridPaste([blankBatchRow()], 1, 3, [['note', 'group', 'password', '']], BATCH_ENTRY_COLUMNS);
  assert.equal(extended[1].notes, 'note');
  assert.equal(extended[1].displayId, '');
  assert.equal(extended[1].launchUrl, '');
  assert.throws(() => applyGridPaste([first], 0, 6, [['one', 'two']], BATCH_ENTRY_COLUMNS), /列数/);
  assert.equal(first.email, '');
});

test('rectangular paste preserves blank cells and middle rows, quoted multiline values and leading zero IDs', () => {
  const matrix = parseGridClipboard('a@example.com\tChrome\t\t001\r\n\t\t\t\r\nb@example.com\tEdge\t"Profile\n43"\t002\r\n');
  assert.deepEqual(matrix, [['a@example.com', 'Chrome', '', '001'], ['', '', '', ''], ['b@example.com', 'Edge', 'Profile\n43', '002']]);
  const rows = applyGridPaste([blankBatchRow()], 0, 0, matrix);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].displayId, '001');
  assert.equal(rows[1].email, '');
  assert.equal(rows[2].email, 'b@example.com');
});

test('paste into an arbitrary cell preserves untouched cells and rejects overflow', () => {
  const first = { ...blankBatchRow(), email: 'keep@example.com', notes: 'keep' };
  const rows = applyGridPaste([first], 0, 1, [['Brave', 'Profile 7']]);
  assert.equal(rows[0].browser, 'Brave');
  assert.equal(rows[0].profile, 'Profile 7');
  assert.equal(rows[0].email, first.email);
  assert.equal(rows[0].notes, 'keep');
  assert.equal(first.browser, '');
  assert.throws(() => applyGridPaste([first], 0, 10, [['secret', 'overflow']]), /列数/);
  assert.throws(() => applyGridPaste([first], MAX_BATCH_ROWS, 0, [['new']]), /1000/);
  assert.throws(() => parseGridClipboard('"unclosed\tquote'), /引号/);
});

test('batch leaves browser and ID empty, normalizes optional URL and preserves exact password whitespace', () => {
  const row = { ...blankBatchRow(), email: ' a@example.com ', password: '  "keep this"  ', launchUrl: 'example.com', cooldownHours: '0.5' };
  const result = validateBatchRows([row, blankBatchRow()]);
  assert.deepEqual(result.errors, []);
  assert.equal(result.filled, 1);
  assert.equal(result.incomplete, 1);
  assert.equal(result.added[0].browser, '');
  assert.equal(result.added[0].displayId, '');
  assert.equal(result.added[0].password, row.password);
  assert.equal(result.added[0].launchUrl, 'https://example.com/');
  assert.equal(result.added[0].cooldownHours, 0.5);
  assert.equal(Object.hasOwn(result.added[0], '_key'), false);
});

test('duplicate accounts are skipped case insensitively without overwriting existing credentials', () => {
  const rows = ['a@example.com', 'B@example.com', 'b@example.com'].map(email => ({ ...blankBatchRow(), email, password: 'new' }));
  const existing = [{ email: 'A@example.com', password: 'existing' }];
  const result = validateBatchRows(rows, existing);
  assert.equal(result.skipped, 2);
  assert.equal(result.added.length, 1);
  assert.equal(result.added[0].email, 'B@example.com');
  assert.equal(existing[0].password, 'existing');
});

test('batch entry keeps same mailbox routes and deduplicates only the matching browser and Profile', () => {
  const existing = [{ email: 'Work', browser: 'Chrome', profile: 'Profile 21', password: 'existing' }];
  const rows = [
    { email: ' work ', browser: 'Chrome', profile: '21', password: 'ignored' },
    { email: 'Work', browser: 'Chrome', profile: 'Profile+21', password: 'plus profile' },
    { email: 'Work', browser: 'Edge', profile: '21', password: 'edge' },
    { email: 'WORK', browser: 'edge', profile: 'PROFILE 21', password: 'ignored too' },
    { email: 'Work', browser: 'Firefox', profile: 'Mail', password: 'firefox' },
    { email: 'Work', browser: 'Firefox', profile: 'mail', password: 'other firefox' },
  ].map(row => ({ ...blankBatchRow(), ...row }));
  const result = validateBatchRows(rows, existing);
  assert.deepEqual(result.errors, []);
  assert.equal(result.skipped, 2);
  assert.deepEqual(result.added.map(entry => entry.password), ['plus profile', 'edge', 'firefox', 'other firefox']);
  assert.equal(existing[0].password, 'existing');
});

test('every filled row is validated and errors never expose secrets', () => {
  const rows = [
    { ...blankBatchRow(), notes: 'missing email' },
    { ...blankBatchRow(), email: 'a@example.com', browser: 'Bad browser', launchUrl: 'javascript:alert(1)', cooldownHours: '0' },
    { ...blankBatchRow(), email: 'b@example.com', totpSecret: 'private-invalid-totp' },
  ];
  const result = validateBatchRows(rows);
  assert.deepEqual(result.errors.map(error => error.key), ['email', 'browser', 'launchUrl', 'cooldownHours', 'totpSecret']);
  assert.equal(result.added.length, 0);
  assert.equal(JSON.stringify(result.errors).includes('private-invalid-totp'), false);
});

test('whitespace-only optional cooldown uses the default instead of storing zero', () => {
  const result = validateBatchRows([{ ...blankBatchRow(), email: 'a@example.com', cooldownHours: '   ' }]);
  assert.deepEqual(result.errors, []);
  assert.equal(result.added[0].cooldownHours, null);
});

test('batch entry preserves literal plus Profile names and passwords', () => {
  const result = validateBatchRows([
    { ...blankBatchRow(), email: 'plus@example.com', browser: 'Brave', profile: 'Profile+21', password: ' keep+this password ' },
    { ...blankBatchRow(), email: 'space@example.com', browser: 'Brave', profile: 'Profile 21' },
    { ...blankBatchRow(), email: 'firefox@example.com', browser: 'Firefox', profile: 'Work+Mail' }
  ]);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.added.map(entry => entry.profile), ['Profile+21', 'Profile 21', 'Work+Mail']);
  assert.equal(result.added[0].password, ' keep+this password ');
});

test('browser Profile accepts directory names but rejects full paths and invalid characters', () => {
  const valid = validateBatchRows(['Default', 'Profile 43', '43', 'Personal_2-test'].map(profile => ({ ...blankBatchRow(), email: `${profile}@example.com`, browser: 'Chrome', profile })));
  assert.deepEqual(valid.errors, []);
  assert.equal(valid.added.length, 4);
  const invalid = validateBatchRows(['C:\\Users\\test\\Default', '../Profile 43', 'Profile\n43', '工作'].map(profile => ({ ...blankBatchRow(), email: 'a@example.com', browser: 'Edge', profile })));
  assert.deepEqual(invalid.errors.map(error => error.key), ['profile', 'profile', 'profile', 'profile']);
  assert.equal(invalid.added.length, 0);
  assert.equal(JSON.stringify(invalid.errors).includes('C:\\Users'), false);
  const system = validateBatchRows([{ ...blankBatchRow(), email: 'default@example.com', browser: '系统默认', profile: 'unused/profile' }]);
  assert.deepEqual(system.errors, []);
});
