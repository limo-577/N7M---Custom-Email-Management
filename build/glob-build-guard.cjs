'use strict';
// Build-only policy, not a patch to picomatch. Unsupported patterns fail loudly.
// Never preload this into raw diagnostics or the shipping application.
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const loaded = new Set(), validated = new Set(), wrapped = new WeakMap();
const log = process.env.N7M_GLOB_GUARD_LOG;
if (!log || !path.isAbsolute(log)) throw Error('An explicit glob guard evidence file is required');
function event(value) { fs.appendFileSync(log, JSON.stringify({ pid: process.pid, ...value }) + '\n'); }
function reject(message) { event({ rejected: true, reason: message }); const error = Error(`BUILD_GLOB_REFUSED: ${message}`); error.code = 'BUILD_GLOB_REFUSED'; throw error; }
function pattern(value) {
  if (Array.isArray(value)) { if (value.length > 64 || value.some(item => typeof item !== 'string')) reject('too many or nested patterns'); value.forEach(pattern); return; }
  if (typeof value !== 'string' || value.length > 512 || /[()|\u0000-\u001f]/.test(value)) reject('unsupported glob syntax or length');
  // Extglobs, regex grouping and nested/expanding braces are outside this build's
  // supported input language. Escaped parentheses are also refused deliberately.
  let depth = 0, alternatives = 0, contents = '';
  for (const c of value) {
    if (c === '{') { if (depth++) reject('nested braces'); contents = ''; alternatives = 1; }
    else if (c === '}') { if (--depth !== 0 || alternatives > 32 || contents.includes('..')) reject('unsupported brace expansion'); }
    else if (depth) { contents += c; if (c === ',') alternatives++; }
  }
  if (depth !== 0) reject('unbalanced braces');
  const segments = value.split(/[\\/]/);
  if (segments.length > 64 || segments.filter(part => part === '**').length > 2) reject('too many glob segments');
  for (const segment of segments) if (segment !== '**' && (segment.match(/\*/g) || []).length > 1) reject('ambiguous repeated wildcard');
}
function options(value) {
  if (value && (value.regex === true || value.prepend || value.expandRange || value.maxExtglobRecursion === false || typeof value.flags === 'string' && !/^[imu]*$/.test(value.flags))) reject('unsupported regex options');
}
function wrap(original, filename) {
  if (wrapped.has(original)) return wrapped.get(original);
  function record() { if (!validated.has(filename)) { validated.add(filename); event({ validatedModule: filename }); } }
  const proxy = new Proxy(original, {
    apply(target, self, args) {
      pattern(args[0]); options(args[1]);
      record();
      // Do not reinterpret parse-state objects supplied by another caller.
      const matcher = Reflect.apply(target, self, args);
      if (typeof matcher !== 'function') return matcher;
      return new Proxy(matcher, { apply(fn, that, values) {
        if (typeof values[0] !== 'string' || values[0].length > 4096) reject('unsupported matching input');
        return Reflect.apply(fn, that, values);
      } });
    },
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      if (['parse', 'scan', 'makeRe'].includes(property)) return (...args) => { pattern(args[0]); options(args[1]); record(); return Reflect.apply(value, target, args); };
      if (property === 'isMatch') return (input, patterns, opts) => { pattern(patterns); options(opts); if (typeof input !== 'string' || input.length > 4096) reject('unsupported matching input'); record(); return value(input, patterns, opts); };
      // These APIs accept caller-created regex/state and cannot be admitted by
      // validating a glob string. Internal implementation calls are unaffected.
      return () => reject(`unreviewed helper API ${String(property)}`);
    }
  });
  wrapped.set(original, proxy); wrapped.set(proxy, proxy);
  if (!loaded.has(filename)) { loaded.add(filename); event({ guardedModule: filename }); }
  return proxy;
}
const originalLoad = Module._load;
function privateEntry(filename, parentFile) {
  const match = /^(.*[\\/]node_modules[\\/]picomatch)[\\/]lib[\\/](?!picomatch\.js$|constants\.js$).+\.js$/.exec(filename);
  if (match && !parentFile?.startsWith(match[1] + path.sep)) reject('external private matcher API');
}
if (typeof Module.registerHooks !== 'function') reject('synchronous CJS/ESM loader hooks unavailable');
Object.defineProperty(globalThis, Symbol.for('n7m.build.glob.wrap'), { value: wrap, writable: false, configurable: false });
Module.registerHooks({ resolve(specifier, context, next) {
  const resolved = next(specifier, context);
  if (resolved.url.startsWith('file:')) privateEntry(fileURLToPath(resolved.url), context.parentURL?.startsWith('file:') ? fileURLToPath(context.parentURL) : undefined);
  return resolved;
}, load(url, context, next) {
  const result = next(url, context);
  if (!url.startsWith('file:')) return result;
  const filename = fileURLToPath(url);
  if (!/[\\/]node_modules[\\/]picomatch[\\/](?:index\.js|lib[\\/]picomatch\.js)$/.test(filename)) return result;
  if (result.format !== undefined && result.format !== 'commonjs') reject(`unexpected matcher module format ${result.format}`);
  // Wrap before Node snapshots CJS exports for ESM imports, including direct
  // imports of lib/picomatch.js. Changing require.cache afterwards is too late.
  const source = result.source == null ? fs.readFileSync(filename, 'utf8') : Buffer.from(result.source).toString('utf8');
  return { ...result, format: 'commonjs', source: source + '\nmodule.exports = globalThis[Symbol.for("n7m.build.glob.wrap")](module.exports, __filename);\n' };
} });
Module._load = function(request, parent, isMain) {
  const filename = Module._resolveFilename(request, parent, isMain);
  if (typeof filename === 'string') {
    privateEntry(filename, parent?.filename);
  }
  const value = Reflect.apply(originalLoad, this, arguments);
  if (typeof value !== 'function') return value;
  if (typeof filename === 'string' && /[\\/]node_modules[\\/]picomatch[\\/](?:index\.js|lib[\\/]picomatch\.js)$/.test(filename)) {
    const guarded = wrap(value, filename);
    if (require.cache[filename]) require.cache[filename].exports = guarded;
    return guarded;
  }
  return value;
};
event({ guardStarted: true, policy: 'restricted-build-globs-v1' });
module.exports = { pattern };
