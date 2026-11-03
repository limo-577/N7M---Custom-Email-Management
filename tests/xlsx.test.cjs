const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const ExcelJS = require('exceljs');
const { createXlsxImporter, LIMITS } = require('../electron/xlsx-import.cjs');

async function workbookBytes(build = workbook => workbook.addWorksheet('Accounts').addRows([['邮箱链接', '浏览器'], ['test@example.com', 'Chrome']])) {
  const workbook = new ExcelJS.Workbook(); build(workbook);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
function importerFor(t, options) {
  const importer = createXlsxImporter(options);
  t.after(() => importer.dispose());
  return importer;
}
async function archive(entries) {
  const zip = new JSZip();
  for (const [name, value] of entries) zip.file(name, value, { createFolders: false });
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
function centralOffset(bytes) { return bytes.readUInt32LE(bytes.length - 6); }

test('isolated XLSX import preserves worksheet selection, empty columns and formatted leading zeroes', async t => {
  const input = await workbookBytes(workbook => {
    const first = workbook.addWorksheet('First');
    first.addRow(['邮箱链接', '', '编号']);
    first.addRow(['first@example.com', '', 7]); first.getCell('C2').numFmt = '000';
    workbook.addWorksheet('Hidden', { state: 'hidden' }).addRow(['hidden@example.com']);
    workbook.addWorksheet('Secret', { state: 'veryHidden' }).addRow(['not-returned@example.com']);
  });
  const saved = Buffer.from(input);
  const sheets = await importerFor(t).parse(input);
  assert.deepEqual(sheets, [
    { name: 'First', rows: [['邮箱链接', '', '编号'], ['first@example.com', '', '007']] },
    { name: 'Hidden', rows: [['hidden@example.com']] }
  ]);
  assert.deepEqual(input, saved, 'caller buffer must not be detached or modified');
});

test('malformed ZIP errors never echo attacker-controlled contents', async t => {
  const importer = importerFor(t);
  await assert.rejects(importer.parse(Buffer.from('password=do-not-echo-this-secret')), error => {
    assert.match(error.message, /无效|损坏/); assert.ok(!error.message.includes('do-not-echo')); return true;
  });
  assert.equal((await importer.parse(await workbookBytes()))[0].name, 'Accounts');
});

test('file byte limit is checked before starting a worker', async t => {
  await assert.rejects(importerFor(t, { limits: { fileBytes: 8 } }).parse(Buffer.alloc(9)), /20 MB/);
});

test('a highly compressed entry is rejected by actual streamed expansion, including dishonest declared size', async t => {
  const bytes = await archive([['huge.xml', Buffer.alloc(1024 * 1024, 65)]]);
  assert.ok(bytes.length < 4096);
  // Lie in both headers. Actual expansion is checked before size-mismatch EOF.
  bytes.writeUInt32LE(1, 22);
  bytes.writeUInt32LE(1, centralOffset(bytes) + 24);
  await assert.rejects(importerFor(t, { limits: { entryBytes: 64 * 1024 } }).parse(bytes), /单个文件解压后过大/);
});

test('combined expansion and entry-count limits reject archives before Excel parsing', async t => {
  const bytes = await archive([['a.xml', Buffer.alloc(40 * 1024, 65)], ['b.xml', Buffer.alloc(40 * 1024, 65)]]);
  await assert.rejects(importerFor(t, { limits: { expandedBytes: 64 * 1024 } }).parse(bytes), /资料总量过大/);
  await assert.rejects(importerFor(t, { limits: { entries: 1 } }).parse(bytes), /内部文件数量过多/);
});

test('ZIP traversal, duplicate paths and encrypted flag are rejected', async t => {
  const importer = importerFor(t);
  await assert.rejects(importer.parse(await archive([['../escape.xml', 'x']])), /无效|损坏/);
  const duplicate = await archive([['a.xml', 'a'], ['b.xml', 'b']]);
  let central = centralOffset(duplicate);
  const next = central + 46 + duplicate.readUInt16LE(central + 28) + duplicate.readUInt16LE(central + 30) + duplicate.readUInt16LE(central + 32);
  const secondLocal = duplicate.readUInt32LE(next + 42);
  duplicate[secondLocal + 30] = 97; duplicate[next + 46] = 97;
  await assert.rejects(importer.parse(duplicate), /无效|损坏/);
  const encrypted = await archive([['a.xml', 'a']]);
  encrypted.writeUInt16LE(encrypted.readUInt16LE(6) | 1, 6);
  central = centralOffset(encrypted);
  encrypted.writeUInt16LE(encrypted.readUInt16LE(central + 8) | 1, central + 8);
  await assert.rejects(importer.parse(encrypted), /无效|损坏/);
});

test('worksheet, row and column limits reject excessive parsed dimensions', async t => {
  const sheets = await workbookBytes(workbook => { workbook.addWorksheet('A').addRow(['a']); workbook.addWorksheet('B').addRow(['b']); });
  await assert.rejects(importerFor(t, { limits: { sheets: 1 } }).parse(sheets), /工作表过多/);
  const rows = await workbookBytes(workbook => workbook.addWorksheet('A').getCell('A3').value = 'a');
  await assert.rejects(importerFor(t, { limits: { rows: 2 } }).parse(rows), /行数过多/);
  const columns = await workbookBytes(workbook => workbook.addWorksheet('A').getCell('C1').value = 'a');
  await assert.rejects(importerFor(t, { limits: { columns: 2 } }).parse(columns), /列数过多/);
  const hidden = await workbookBytes(workbook => {
    workbook.addWorksheet('Visible').addRow(['a']);
    workbook.addWorksheet('Hidden', { state: 'veryHidden' }).getCell('A3').value = 'hidden';
  });
  await assert.rejects(importerFor(t, { limits: { rows: 2 } }).parse(hidden), /行数过多/);
});

test('cell, total-character and individual-cell budgets bound the returned payload', async t => {
  const cells = await workbookBytes(workbook => workbook.addWorksheet('A').addRow(['a', '', 'b']));
  await assert.rejects(importerFor(t, { limits: { cells: 2 } }).parse(cells), /单元格数量过多/);
  const text = await workbookBytes(workbook => workbook.addWorksheet('A').addRows([['abc'], ['def']]));
  await assert.rejects(importerFor(t, { limits: { characters: 5 } }).parse(text), /文本总量过大/);
  await assert.rejects(importerFor(t, { limits: { cellCharacters: 2 } }).parse(text), /单个单元格文本过长/);
});

test('aborted signal cancels real parsing and permits a subsequent import', async t => {
  const importer = importerFor(t), controller = new AbortController(), bytes = await workbookBytes();
  const pending = importer.parse(bytes, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /已取消/);
  assert.equal((await importer.parse(bytes))[0].name, 'Accounts');
});

test('timeout terminates a synchronous worker loop without blocking the parent, and concurrency is bounded', async t => {
  const root = path.resolve(__dirname, '..', 'test-results'); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'xlsx-worker-fixture-'));
  const file = path.join(dir, 'loop.cjs'); fs.writeFileSync(file, 'while (true) {}');
  t.after(() => { fs.unlinkSync(file); fs.rmdirSync(dir); });
  const importer = importerFor(t, { timeoutMs: 100, workerPath: file });
  let responsive = false;
  const pending = importer.parse(Buffer.from('fixture'));
  setTimeout(() => { responsive = true; }, 20);
  await assert.rejects(importer.parse(Buffer.from('fixture')), /正在读取/);
  await assert.rejects(pending, /超时/);
  assert.equal(responsive, true);
  const retry = importer.parse(Buffer.from('fixture'));
  importer.cancel(); await assert.rejects(retry, /已取消/);
  importer.dispose(); await assert.rejects(importer.parse(Buffer.from('fixture')), /已关闭/);
});

test('internal test overrides may lower but never raise production resource limits', () => {
  assert.throws(() => createXlsxImporter({ limits: { entryBytes: LIMITS.entryBytes + 1 } }));
  assert.throws(() => createXlsxImporter({ timeoutMs: 15001 }));
});
