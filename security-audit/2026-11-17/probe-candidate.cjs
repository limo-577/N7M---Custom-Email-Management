'use strict';
// Tiny synthetic workbooks only; vulnerable parsing stays in disposable workers.
const { Worker } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');
const JSZip = require('jszip');
const root = path.resolve(__dirname, '../..');
async function probe(bytes, library) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(`
      const {parentPort,workerData}=require('node:worker_threads');
      const ExcelJS=require(workerData.library);
      new ExcelJS.Workbook().xlsx.load(Buffer.from(workerData.bytes))
        .then(()=>parentPort.postMessage({loaded:true,pollutedKeys:Object.keys(Object.prototype)}))
        .catch(error=>parentPort.postMessage({loaded:false,errorType:error.name,pollutedKeys:Object.keys(Object.prototype)}));
    `, { eval: true, workerData: { bytes, library }, resourceLimits: { maxOldGenerationSizeMb: 128 } });
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('Probe timeout')); }, 10000);
    worker.once('message', async result => { clearTimeout(timer); await worker.terminate(); resolve(result); });
    worker.once('error', error => { clearTimeout(timer); reject(error); });
  });
}
(async () => {
  const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet('Probe');
  sheet.addRows([[1], [2]]);
  sheet.addConditionalFormatting({ ref: 'A1:A2', rules: [{ type: 'dataBar', cfvo: [{ type: 'min' }, { type: 'max' }], color: { argb: 'FF00FF00' } }] });
  const input = await workbook.xlsx.writeBuffer();
  const cases = {};
  const x14 = await JSZip.loadAsync(input), name = 'xl/worksheets/sheet1.xml';
  const original = await x14.file(name).async('string');
  const changed = original.replace(/(<x14:cfRule\b[^>]*\bid=")[^"]+("[^>]*>)/, '$1__proto__$2');
  if (changed === original) throw new Error('Missing x14 fixture');
  x14.file(name, changed); cases.x14 = await x14.generateAsync({ type: 'nodebuffer' });
  const defined = await JSZip.loadAsync(input), book = 'xl/workbook.xml';
  let xml = await defined.file(book).async('string');
  const definition = '<definedName name="probe">__proto__!$A$1:$A$3</definedName>';
  xml = xml.includes('</definedNames>') ? xml.replace('</definedNames>', definition + '</definedNames>')
    : xml.replace('</workbook>', '<definedNames>' + definition + '</definedNames></workbook>');
  defined.file(book, xml); cases.definedName = await defined.generateAsync({ type: 'nodebuffer' });
  const results = {};
  for (const [key, bytes] of Object.entries(cases)) {
    results[key] = { current: await probe(bytes, require.resolve('exceljs')),
      candidate: await probe(bytes, path.join(root, 'tmp/security-excel-engine/node_modules/exceljs-hardened')) };
    if (!results[key].current.pollutedKeys.length || results[key].candidate.pollutedKeys.length) throw new Error('Unexpected pollution result: ' + key);
  }
  results.parentPrototypeUnchanged = Object.keys(Object.prototype).length === 0;
  fs.writeFileSync(path.join(__dirname, 'candidate-probes.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
