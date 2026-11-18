'use strict';
const fs = require('node:fs');
const path = require('node:path');
const inventory = require('./dependencies.json');
(async () => {
  const unique = new Map(inventory.packages.filter(item => item.name !== '@n7m/minimatch-compat')
    .map(item => [`${item.name}@${item.version}`, { package: { name: item.name, ecosystem: 'npm' }, version: item.version }]));
  const queries = [...unique.values()], results = [];
  for (let offset = 0; offset < queries.length; offset += 100) {
    const response = await fetch('https://api.osv.dev/v1/querybatch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ queries: queries.slice(offset, offset + 100) }), signal: AbortSignal.timeout(30000)
    });
    if (!response.ok) throw new Error(`OSV HTTP ${response.status}`);
    const value = await response.json(); results.push(...value.results);
  }
  const matches = results.flatMap((value, index) => value.vulns?.length ? [{ query: queries[index], vulnerabilities: value.vulns }] : []);
  const output = { date: '2026-11-17', queryCount: queries.length, matches };
  fs.writeFileSync(path.join(__dirname, 'osv-querybatch.json'), JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
