'use strict';
const fs = require('node:fs');
const path = require('node:path');

function within(base, target, allowBase = false) {
  const relative = path.relative(base, target);
  return relative === '' ? allowBase : !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
}

// Check lexical containment before touching the filesystem. Do not normalize
// away traversal, or follow junctions/symlinks, including dangling links.
function checkedPath(root, directory, value, { cwd = root, allowBase = false } = {}) {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.split(/[\\/]/).includes('..')) throw Error('Path traversal or invalid path');
  if (process.platform === 'win32' && /^[a-z]:[^\\/]/i.test(value)) throw Error('Drive-relative paths are not accepted');
  if (process.platform === 'win32' && value.split(/[\\/]/).some(part => part !== '.' && /[. ]$/.test(part))) throw Error('Ambiguous Windows path segment');
  root = path.resolve(root);
  const base = path.join(root, directory), target = path.resolve(cwd, value);
  if (!within(base, target, allowBase)) throw Error(`Path must be ${allowBase ? 'in' : 'under'} ${directory}/`);
  const canonicalRoot = fs.realpathSync(root);
  let current = root;
  for (const component of ['', ...path.relative(root, target).split(path.sep)]) {
    if (component) current = path.join(current, component);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) { if (error.code === 'ENOENT') break; throw error; }
    if (stat.isSymbolicLink()) throw Error('Release/evidence paths must not contain symbolic links or junctions');
    const canonical = fs.realpathSync(current);
    if (!within(canonicalRoot, canonical, true)) throw Error('Canonical path escapes the checkout');
    if (within(base, current, true) && !within(path.join(canonicalRoot, directory), canonical, true)) throw Error('Canonical path escapes the permitted directory');
  }
  return target;
}

const outputPath = (root, value, cwd = root) => checkedPath(root, 'release', value, { cwd, allowBase: true });
const reportPath = (root, value, cwd = root) => checkedPath(root, '.risk-build', value, { cwd });
function verificationPaths(root, args, cwd = root) {
  if (args.length !== 4) throw Error('Usage: verify-release.cjs --output DIRECTORY --report FILE');
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!['--output', '--report'].includes(key) || values[key] !== undefined || !value || value.startsWith('--')) throw Error('Unknown, duplicate or missing verification argument');
    values[key] = value;
  }
  if (!values['--output'] || !values['--report']) throw Error('Both --output and --report are required');
  return { output: outputPath(root, values['--output'], cwd), report: reportPath(root, values['--report'], cwd) };
}
module.exports = { within, checkedPath, outputPath, reportPath, verificationPaths };
