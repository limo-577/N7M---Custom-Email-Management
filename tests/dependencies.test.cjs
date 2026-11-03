const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const { createRequire } = require('module');
const { spawnSync } = require('child_process');
const minimatch = require('minimatch');

function fixture() {
  const parent = path.resolve(__dirname, '../test-results');
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, 'dependency-'));
  fs.mkdirSync(path.join(dir, 'nested'));
  fs.mkdirSync(path.join(dir, '.hidden'));
  for (const [file, value] of Object.entries({ 'a.txt': 'a', 'b.js': 'b', 'nested/c.txt': 'c', '.hidden/d.txt': 'd' })) {
    fs.writeFileSync(path.join(dir, file), value);
  }
  return dir;
}
const forward = value => value.replace(/\\/g, '/');

test('minimatch adapter uses the patched engine for callable, named and legacy set matching', () => {
  assert.equal(require('minimatch-engine/package.json').version, '11.0.4');
  assert.equal(minimatch('nested/a.txt', '**/*.txt'), true);
  assert.equal(minimatch.minimatch('nested/a.js', '**/*.txt'), false);
  assert.deepEqual(minimatch.match(['a.js', 'a.txt'], '*.txt'), ['a.txt']);
  for (const [pattern, file, expected] of [
    ['**/*.txt', 'nested/a.txt', true], ['**/*.txt', 'nested/a.js', false],
    ['**/*.txt', '.hidden/a.txt', false], ['*.{js,txt}', 'a.txt', true],
    ['!**/*.js', 'nested/a.txt', true], ['nested/+(a|b).txt', 'nested/a.txt', true]
  ]) assert.equal(new minimatch.Minimatch(pattern).match(file), expected);
  const segment = new minimatch.Minimatch('*.txt').set[0][0];
  assert.equal(segment._glob, '*.txt');
  assert.deepEqual('a.txt'.match(segment), ['a.txt']);
  assert.equal('a.js'.match(segment), null);
  assert.equal(new minimatch.Minimatch('**').set[0][0], minimatch.GLOBSTAR);
});

test('patched preprocessing rejects amplification within an explicit expansion budget', () => {
  const run = spawnSync(process.execPath, ['-e', `
    const {Minimatch}=require('minimatch');
    try { new Minimatch('**/../a/b/'.repeat(32), {optimizationLevel:2,braceExpandMax:128}); }
    catch (error) { if (!/max|limit|many|expand|glob/i.test(error.message)) throw error; }
  `], { cwd: path.resolve(__dirname, '..'), timeout: 3000, windowsHide: true });
  assert.equal(run.error, undefined);
  assert.equal(run.status, 0, run.stderr.toString());
});

test('glob 7, filelist and readdir-glob preserve recursive, dot and exclusion patterns', async () => {
  const dir = fixture();
  const glob = require('glob');
  const options = { cwd: dir, nodir: true, ignore: ['nested/**'] };
  assert.deepEqual(glob.sync('**/*.txt', options), ['a.txt']);
  assert.deepEqual((await promisify(glob)('**/*.txt', { cwd: dir, nodir: true, dot: true })).sort(), ['.hidden/d.txt', 'a.txt', 'nested/c.txt']);
  const { FileList } = require('filelist');
  const files = new FileList().include(forward(path.join(dir, '**/*.txt'))).exclude(forward(path.join(dir, 'nested/**'))).toArray();
  assert.deepEqual(files.map(file => path.basename(file)), ['a.txt']);
  const matches = await new Promise((resolve, reject) => {
    const files = [];
    require('readdir-glob')(dir, { pattern: '**/*.txt', nodir: true, ignore: 'nested/**' })
      .on('match', file => files.push(forward(file.relative)))
      .on('end', () => resolve(files.sort())).on('error', reject);
  });
  assert.deepEqual(matches, ['a.txt']);
});

test('archiver glob and rimraf use the patched matcher without changing inclusion/deletion scope', async () => {
  const dir = fixture();
  const archive = require('archiver')('zip');
  const chunks = [];
  const complete = new Promise((resolve, reject) => {
    archive.on('data', chunk => chunks.push(chunk));
    archive.on('end', resolve); archive.on('error', reject);
  });
  archive.glob('**/*.txt', { cwd: dir, ignore: ['nested/**'] });
  await archive.finalize(); await complete;
  const zip = await require('jszip').loadAsync(Buffer.concat(chunks));
  assert.deepEqual(Object.keys(zip.files), ['a.txt']);
  await promisify(require('rimraf'))(forward(path.join(dir, 'nested/*.txt')));
  assert.equal(fs.existsSync(path.join(dir, 'nested/c.txt')), false);
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'a');
  assert.equal(fs.readFileSync(path.join(dir, '.hidden/d.txt'), 'utf8'), 'd');
});

test('ASAR pack/unpack selection and dir-compare filters accept the legacy callable interface', async () => {
  const dir = fixture(), asar = require('@electron/asar');
  const output = path.join(path.dirname(dir), `${path.basename(dir)}.asar`);
  await asar.createPackageWithOptions(dir, output, { unpack: '**/c.txt' });
  assert.equal(asar.extractFile(output, 'a.txt').toString(), 'a');
  assert.equal(asar.extractFile(output, 'nested/c.txt').toString(), 'c');
  assert.equal(asar.statFile(output, 'nested/c.txt').unpacked, true);
  const other = fixture(); fs.writeFileSync(path.join(other, 'b.js'), 'different but excluded');
  const compare = await require('dir-compare').compare(dir, other, { compareContent: true, includeFilter: '*.txt', excludeFilter: '.hidden' });
  assert.equal(compare.same, true);
  assert.equal(compare.differences, 0);
});

test('electron-builder file filters preserve positive, negative and dot-file patterns', () => {
  const { FileMatcher } = require('app-builder-lib/out/fileMatcher');
  const { createFilter } = require('app-builder-lib/out/util/filter');
  const root = path.resolve(__dirname, '..');
  const matcher = new FileMatcher(root, root, value => value, ['electron/**/*', '!electron/private/**']);
  const patterns = []; matcher.computeParsedPatterns(patterns);
  const filter = createFilter(root, patterns);
  const file = { isDirectory: () => false };
  assert.equal(filter(path.join(root, 'electron/main.cjs'), file), true);
  assert.equal(filter(path.join(root, 'electron/.config'), file), true);
  assert.equal(filter(path.join(root, 'electron/private/key.txt'), file), false);
  assert.equal(filter(path.join(root, 'src/main.jsx'), file), false);
});

test('uuid 11 rejects short buffers and ExcelJS conditional-formatting round trips remain compatible', async () => {
  const uuid = require('uuid');
  assert.equal(require('uuid/package.json').version, '11.1.1');
  assert.equal(uuid.validate(uuid.v4()), true);
  assert.throws(() => uuid.v5('test', uuid.v5.DNS, Buffer.alloc(8), 4), RangeError);
  const ExcelJS = require('exceljs');
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('Accounts');
  sheet.addRows([['邮箱链接', '浏览器', '编号'], ['dependency@example.com', 'Chrome', 1]]);
  sheet.getCell('C2').numFmt = '000';
  sheet.addConditionalFormatting({ ref: 'C2', rules: [{ type: 'dataBar', cfvo: [{ type: 'min' }, { type: 'max' }], color: { argb: 'FF00FF00' } }] });
  const loaded = new ExcelJS.Workbook(); await loaded.xlsx.load(await book.xlsx.writeBuffer());
  assert.equal(loaded.worksheets[0].getCell('A2').text, 'dependency@example.com');
  assert.equal(loaded.worksheets[0].getCell('C2').numFmt, '000');
  const excelRequire = createRequire(require.resolve('exceljs'));
  assert.equal(excelRequire('uuid/package.json').version, '11.1.1');
});
