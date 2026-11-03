// Older build dependencies call require('minimatch') as a function, whereas
// modern minimatch exports an object. Match using the patched official engine;
// this adapter contains no pattern parser, preprocessing or regular-expression code.
const engine = require('minimatch-engine');
class Minimatch extends engine.Minimatch {
  constructor(pattern, options) {
    super(pattern, options);
    // glob 7 walks Minimatch.set and invokes String#match on each path
    // segment. minimatch 11 uses a bounded, nonrecursive Matcher instead of
    // RegExp. Preserve its matcher and expose the two legacy hooks glob uses.
    for (const row of this.set) for (const segment of row) {
      if (segment && typeof segment === 'object' && typeof segment.test === 'function') {
        segment._glob = segment.pattern;
        segment[Symbol.match] = function (value) { return this.test(value) ? [value] : null; };
      }
    }
  }
}
function minimatch(value, pattern, options) {
  return engine.minimatch(value, pattern, options);
}
Object.assign(minimatch, engine);
minimatch.Minimatch = Minimatch;
// filelist 1 calls match() with path.normalize() patterns on Windows. Its
// legacy matcher treated those backslashes as separators, not escape tokens.
minimatch.match = (list, pattern, options = {}) => engine.match(list, pattern, {
  ...(process.platform === 'win32' ? { windowsPathsNoEscape: true } : {}),
  ...options
});
module.exports = minimatch;
