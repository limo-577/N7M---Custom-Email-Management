const test = require('node:test');
const assert = require('node:assert/strict');
const { checkPolicy, checkUpstream } = require('../build/check-dependencies.cjs');
const sourcePolicy = require('../security-audit/dependency-policy.json');
const sourceLock = require('../package-lock.json');
const sourceManifest = require('../package.json');
function fixture() {
  return { policy: structuredClone(sourcePolicy), lock: structuredClone(sourceLock), manifest: structuredClone(sourceManifest), today: '2026-11-04' };
}

test('the reviewed lockfile has exactly five accepted deprecated packages and fixed security pins', () => {
  const result = checkPolicy(fixture());
  assert.deepEqual(result.errors, []);
  assert.equal(result.deprecatedCount, 5);
});
test('new deprecated dependencies, including relocated copies, require explicit review', () => {
  const input = fixture();
  input.lock.packages['node_modules/example/node_modules/glob'] = { version: '7.2.3', deprecated: 'unsupported' };
  const result = checkPolicy(input);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /Unreviewed deprecated package.*example/);
});
test('changed exception versions and removed deprecation metadata cannot silently bypass review', () => {
  const changed = fixture(); changed.lock.packages['node_modules/glob'].version = '7.2.4';
  assert.match(checkPolicy(changed).errors.join('\n'), /Accepted exception changed/);
  const hidden = fixture(); delete hidden.lock.packages['node_modules/glob'].deprecated;
  assert.match(checkPolicy(hidden).errors.join('\n'), /Deprecation metadata changed/);
  const removed = fixture(); delete removed.lock.packages['node_modules/glob'];
  assert.match(checkPolicy(removed).errors.join('\n'), /no longer exists/);
});
test('the monthly review date fails on the due date, with an actionable renewal message', () => {
  const input = fixture(); input.today = '2026-12-04';
  assert.match(checkPolicy(input).errors.join('\n'), /review is due.*2026-12-04/);
  input.today = '2026-12-03'; assert.equal(checkPolicy(input).ok, true);
});
test('aliases are checked by real package name and additional vulnerable protected versions fail', () => {
  const engine = fixture(); engine.lock.packages['node_modules/minimatch-engine'].version = '10.2.6';
  assert.match(checkPolicy(engine).errors.join('\n'), /Protected dependency changed.*minimatch-engine/);
  const extra = fixture(); extra.lock.packages['node_modules/example/node_modules/minimatch'] = { version: '10.2.6' };
  assert.match(checkPolicy(extra).errors.join('\n'), /Protected dependency changed.*minimatch/);
  const manifest = fixture(); manifest.manifest.dependencies['exceljs-hardened'] = '^5.1.1';
  assert.match(checkPolicy(manifest).errors.join('\n'), /Manifest pin changed/);
});
test('upstream release checks fail on a new version or deprecation without installing anything', async () => {
  const seen = [];
  const request = version => async (url, options) => {
    seen.push({ url, options }); return { ok: true, json: async () => ({ name: 'exceljs-hardened', version }) };
  };
  assert.deepEqual(await checkUpstream(sourcePolicy, { fetchImpl: request('5.1.1') }), []);
  assert.match((await checkUpstream(sourcePolicy, { fetchImpl: request('5.2.0') })).join('\n'), /upstream now reports 5.2.0/);
  assert.equal(seen[0].url, 'https://registry.npmjs.org/exceljs-hardened/latest');
  assert.equal(seen[0].options.redirect, 'error');
  const deprecated = await checkUpstream(sourcePolicy, { fetchImpl: async () => ({ ok: true, json: async () => ({ name: 'exceljs-hardened', version: '5.1.1', deprecated: 'unsupported' }) }) });
  assert.match(deprecated.join('\n'), /now marked deprecated/);
});
test('network errors, invalid registry responses and altered endpoints fail closed', async () => {
  const failure = await checkUpstream(sourcePolicy, { fetchImpl: async () => { throw new Error('offline'); } });
  assert.match(failure.join('\n'), /Cannot verify.*Retry/);
  const invalid = await checkUpstream(sourcePolicy, { fetchImpl: async () => ({ ok: true, json: async () => ({ name: 'other', version: '5.1.1' }) }) });
  assert.match(invalid.join('\n'), /invalid registry metadata/);
  const input = structuredClone(sourcePolicy); input.exceljsMaintenance.registryEndpoint = 'http://localhost/';
  const endpoint = await checkUpstream(input, { fetchImpl: async () => { assert.fail('must not request a policy-controlled endpoint'); } });
  assert.match(endpoint.join('\n'), /official npm registry/);
});
