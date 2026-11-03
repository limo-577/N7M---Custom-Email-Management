const { parentPort, workerData } = require('worker_threads');
const JSZip = require('jszip');

function fail(code = 'INVALID_XLSX') { const error = new Error(code); error.code = code; throw error; }
function safeName(name) {
  const parts = name.split('/');
  if (!name || name.startsWith('/') || /[\\:\x00-\x1f\x7f]/.test(name) || parts.some((part, index) => part === '.' || part === '..' || (!part && index !== parts.length - 1))) fail();
}

// Inspect the central directory before JSZip can merge duplicate/sanitized names.
// XLSX files of <=20 MB do not need ZIP64 or multipart ZIP support; reject both.
function inspectDirectory(bytes, limits) {
  if (bytes.length < 22 || bytes.readUInt32LE(0) !== 0x04034b50) fail();
  let end = -1;
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65557); index--) {
    if (bytes.readUInt32LE(index) === 0x06054b50 && index + 22 + bytes.readUInt16LE(index + 20) === bytes.length) { end = index; break; }
  }
  if (end < 0) fail();
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), offset = bytes.readUInt32LE(end + 16);
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== count || count === 65535 || size === 0xffffffff || offset === 0xffffffff || offset + size !== end) fail();
  if (count > limits.entries) fail('LIMIT_ENTRIES');
  const names = new Set(), ranges = [];
  let index = offset;
  for (let number = 0; number < count; number++) {
    if (index + 46 > end || bytes.readUInt32LE(index) !== 0x02014b50) fail();
    const flags = bytes.readUInt16LE(index + 8), method = bytes.readUInt16LE(index + 10);
    const compressed = bytes.readUInt32LE(index + 20), expanded = bytes.readUInt32LE(index + 24);
    const nameLength = bytes.readUInt16LE(index + 28), extraLength = bytes.readUInt16LE(index + 30), commentLength = bytes.readUInt16LE(index + 32);
    const local = bytes.readUInt32LE(index + 42), next = index + 46 + nameLength + extraLength + commentLength;
    if ((flags & 0x41) || ![0, 8].includes(method) || compressed === 0xffffffff || expanded === 0xffffffff || bytes.readUInt16LE(index + 34) || next > end || local + 30 > offset) fail();
    const rawName = bytes.subarray(index + 46, index + 46 + nameLength), name = rawName.toString('utf8');
    safeName(name);
    if (names.has(name)) fail();
    names.add(name);
    // Reject ZIP64 and Unicode path aliases, preventing two effective names.
    let extra = index + 46 + nameLength;
    const extraEnd = extra + extraLength;
    while (extra < extraEnd) {
      if (extra + 4 > extraEnd) fail();
      const kind = bytes.readUInt16LE(extra), length = bytes.readUInt16LE(extra + 2);
      if ([0x0001, 0x7075].includes(kind) || extra + 4 + length > extraEnd) fail();
      extra += 4 + length;
    }
    if (bytes.readUInt32LE(local) !== 0x04034b50 || bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method) fail();
    const localNameLength = bytes.readUInt16LE(local + 26), localExtraLength = bytes.readUInt16LE(local + 28);
    const data = local + 30 + localNameLength + localExtraLength;
    if (data + compressed > offset || localNameLength !== nameLength || !rawName.equals(bytes.subarray(local + 30, local + 30 + localNameLength))) fail();
    ranges.push([local, data + compressed]);
    index = next;
  }
  if (index !== end || !count) fail();
  ranges.sort((a, b) => a[0] - b[0]);
  for (let number = 1; number < ranges.length; number++) if (ranges[number][0] < ranges[number - 1][1]) fail();
  return names;
}

async function verifyArchive(bytes, limits) {
  const names = inspectDirectory(bytes, limits);
  const zip = await JSZip.loadAsync(bytes, { createFolders: false, checkCRC32: false });
  const entries = Object.values(zip.files);
  if (entries.length !== names.size) fail();
  let total = 0;
  for (const entry of entries) {
    safeName(entry.name);
    if (!names.has(entry.name) || (entry.unsafeOriginalName && entry.unsafeOriginalName !== entry.name)) fail();
    // Directory entries can also carry bytes; meter their contents as well.
    await new Promise((resolve, reject) => {
      let expanded = 0, settled = false;
      const stream = entry.internalStream('uint8array');
      stream.on('data', chunk => {
        if (settled) return;
        expanded += chunk.byteLength; total += chunk.byteLength;
        let code;
        if (expanded > limits.entryBytes) code = 'LIMIT_ENTRY';
        else if (total > limits.expandedBytes) code = 'LIMIT_EXPANDED';
        if (code) { settled = true; stream.pause(); const error = new Error(code); error.code = code; reject(error); }
      });
      stream.on('error', () => { if (!settled) { settled = true; reject(new Error('INVALID_XLSX')); } });
      stream.on('end', () => { if (!settled) { settled = true; resolve(); } });
      stream.resume();
    });
  }
}

async function parseWorkbook(input, limits) {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (!bytes.length || bytes.length > limits.fileBytes) fail('LIMIT_FILE');
  await verifyArchive(bytes, limits);
  // Load ExcelJS only after the streamed expansion check. This uses its Node
  // entrypoint, so patched lockfile dependencies replace the old browser bundle.
  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  if (workbook.worksheets.length > limits.sheets) fail('LIMIT_SHEETS');
  if (!workbook.worksheets.some(sheet => sheet.state !== 'veryHidden')) fail('NO_SHEETS');
  let cells = 0, characters = 0;
  // All sheets consume parse resources, including ones excluded from the UI.
  return workbook.worksheets.map(sheet => {
    if (sheet.rowCount > limits.rows) fail('LIMIT_ROWS');
    if (sheet.columnCount > limits.columns) fail('LIMIT_COLUMNS');
    const rows = [];
    sheet.eachRow(row => {
      if (row.number > limits.rows) fail('LIMIT_ROWS');
      if (row.cellCount > limits.columns) fail('LIMIT_COLUMNS');
      cells += row.cellCount;
      if (cells > limits.cells) fail('LIMIT_CELLS');
      const values = [];
      for (let index = 1; index <= row.cellCount; index++) {
        const cell = row.getCell(index), format = cell.numFmt || '';
        if (format.length > limits.cellCharacters) fail('LIMIT_CELL');
        const value = cell.type === ExcelJS.ValueType.Number && /^0+$/.test(format)
          ? String(cell.value).padStart(format.length, '0') : cell.text;
        if (value.length > limits.cellCharacters) fail('LIMIT_CELL');
        characters += value.length;
        if (characters > limits.characters) fail('LIMIT_CHARACTERS');
        values.push(value);
      }
      rows.push(values);
    });
    return sheet.state === 'veryHidden' ? null : { name: sheet.name, rows };
  }).filter(Boolean);
}

if (parentPort) {
  parseWorkbook(workerData.bytes, workerData.limits)
    .then(sheets => parentPort.postMessage({ ok: true, sheets }))
    .catch(error => parentPort.postMessage({ ok: false, code: error.code || 'INVALID_XLSX' }));
}
module.exports = { inspectDirectory, verifyArchive, parseWorkbook };
