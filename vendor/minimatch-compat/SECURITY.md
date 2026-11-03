# Patched minimatch compatibility adapter

The root npm override routes old and modern minimatch consumers through this
small local package. All pattern matching, parsing and preprocessing use the
official `minimatch` **11.0.4** package, installed under the `minimatch-engine`
npm alias. This is not a vendored copy of an affected minimatch implementation.
The alias avoids an override recursively replacing its own engine dependency.

The primary adaptation is the CommonJS export shape: legacy consumers expect
`require('minimatch')(path, pattern)`, while modern consumers access named
properties such as `Minimatch`, `GLOBSTAR`, `match` and `minimatch`.

Old `glob` 7 also walks `Minimatch.set` and uses `String#match` and `_glob` on
its segments. A subclass attaches `_glob` metadata and a `Symbol.match` hook
to the official nonrecursive Matcher objects; the hook delegates to the
upstream `.test()` method. It does **not** recreate regular expressions,
old glob parsing, or the removed `makeRe` API. New upstream dependencies must
be tested before adopting this adapter for additional callers.

For `filelist` 1's `path.normalize()` patterns, the legacy list `match()` API
defaults to Windows path separators on Windows, unless the caller explicitly
sets a different option. Named engine APIs and direct matching stay upstream.

The implementation fixes GHSA-g3hv-75wg-m249 by using the upstream patched
engine, not by ignoring the advisory or filtering npm audit results.
References:

- https://github.com/advisories/GHSA-g3hv-75wg-m249
- https://github.com/isaacs/minimatch/releases/tag/v11.0.4

Compatibility tests exercise the actual installed consumers, including glob,
archiver/readdir-glob, rimraf, filelist, dir-compare, ASAR and builder filters.
Root build and packaging validation is required after changes. Remove this
adapter when the parent packages support a fixed minimatch release natively.
