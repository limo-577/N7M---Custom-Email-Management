const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const packages = Object.entries(lock.packages).filter(([location]) => location).map(([location, value]) => ({
  path: location, name: value.name || location.split('node_modules/').pop(), version: value.version,
  dev: !!value.dev, optional: !!value.optional, deprecated: value.deprecated || null,
  integrity: value.integrity || null
}));
fs.writeFileSync(path.join(__dirname, 'dependencies.json'), JSON.stringify({ direct: lock.packages[''], packages }, null, 2));
console.log(JSON.stringify({
  direct: Object.keys(lock.packages[''].dependencies || {}).length + Object.keys(lock.packages[''].devDependencies || {}).length,
  entries: packages.length,
  deprecated: packages.filter(value => value.deprecated).map(value => ({ name: value.name, version: value.version }))
}));
