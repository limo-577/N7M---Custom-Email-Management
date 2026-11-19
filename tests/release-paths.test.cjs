'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { parse } = require('yaml');
const { outputPath, reportPath, verificationPaths } = require('../build/release-paths.cjs');
const project = path.resolve(__dirname, '..');
function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'n7m-release-paths-'));
  const root = path.join(temporary, 'checkout');
  fs.mkdirSync(path.join(root, 'release'), { recursive: true });
  fs.mkdirSync(path.join(root, '.risk-build'), { recursive: true });
  fs.mkdirSync(path.join(temporary, 'outside'));
  t.after(() => {
    assert.ok(path.resolve(temporary).startsWith(path.join(path.resolve(os.tmpdir()), 'n7m-release-paths-')));
    fs.rmSync(temporary, { recursive: true, force: true });
  });
  return { root, temporary };
}
function junction(t, target, link) {
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  t.after(() => { if (fs.lstatSync(link, { throwIfNoEntry: false })) fs.unlinkSync(link); });
}
test('release root, absolute root and legitimate existing or new descendants are accepted', t => {
  const { root } = fixture(t), base = path.join(root, 'release');
  for (const value of ['release', './release/', base]) assert.equal(outputPath(root, value), base);
  assert.throws(() => outputPath(root, 'release', path.dirname(root)), /release\//);
  fs.mkdirSync(path.join(base, 'existing'));
  for (const value of ['release/existing', 'release/new/subdir', 'release/版本 1.8.3', path.join(base, 'absolute')]) {
    assert.equal(outputPath(root, value), path.resolve(root, value));
  }
});
test('adjacent release-backup, other absolute directories and checkout root are refused', t => {
  const { root, temporary } = fixture(t);
  for (const value of ['release-backup', 'release-backup/output', path.join(root, 'release-backup'), temporary, root]) assert.throws(() => outputPath(root, value), /release\//);
});
test('traversal is refused before normalization even if it would return inside release', t => {
  const { root } = fixture(t);
  for (const value of ['release/../outside', 'release/sub/../../outside', 'release/../release', 'release/sub/../safe', 'release\\..\\outside']) assert.throws(() => outputPath(root, value), /traversal/);
  assert.throws(() => reportPath(root, '.risk-build/sub/../../outside.json'), /traversal/);
  if (process.platform === 'win32') {
    for (const value of ['release/sub/.. /.. /outside', 'release/sub/.../outside', 'release/sub./child', 'D:release']) assert.throws(() => outputPath(root, value));
  }
});
test('report files remain inside .risk-build and cannot use its root or adjacent directory', t => {
  const { root } = fixture(t);
  assert.equal(reportPath(root, '.risk-build/new/report.json'), path.join(root, '.risk-build/new/report.json'));
  for (const value of ['.risk-build', '.risk-build-backup/report.json', 'release/report.json', path.join(root, 'external.json')]) assert.throws(() => reportPath(root, value));
});
test('junction escape, dangling links and even internal directory links are refused', t => {
  const { root, temporary } = fixture(t), base = path.join(root, 'release');
  for (const [name, target] of [['escape', path.join(temporary, 'outside')], ['dangling', path.join(temporary, 'missing')], ['internal', path.join(root, '.risk-build')]]) {
    const link = path.join(base, name); junction(t, target, link);
    assert.throws(() => outputPath(root, link), /symbolic links or junctions/);
    assert.throws(() => outputPath(root, path.join(link, 'child')), /symbolic links or junctions/);
  }
});
test('a linked release root or report ancestor is refused before reads or directory creation', t => {
  const { root, temporary } = fixture(t);
  fs.rmdirSync(path.join(root, 'release')); junction(t, path.join(temporary, 'outside'), path.join(root, 'release'));
  assert.throws(() => outputPath(root, 'release'), /symbolic links or junctions/);
  const reportParent = path.join(root, '.risk-build/redirect'); junction(t, path.join(temporary, 'outside'), reportParent);
  assert.throws(() => reportPath(root, '.risk-build/redirect/new/report.json'), /symbolic links or junctions/);
  assert.equal(fs.existsSync(path.join(temporary, 'new')), false);
  assert.equal(fs.existsSync(path.join(temporary, 'outside/new')), false);
});
test('duplicate, unknown and missing flags are refused, argument order is supported', t => {
  const { root } = fixture(t);
  assert.equal(verificationPaths(root, ['--report', '.risk-build/report.json', '--output', 'release']).output, path.join(root, 'release'));
  for (const args of [[], ['--output', 'release'], ['--output', 'release', '--output', 'release'], ['--output', '--report', '--report', 'x'], ['--other', 'release', '--report', '.risk-build/r.json']]) assert.throws(() => verificationPaths(root, args));
});
test('actual workflow build, verifier, upload and publish paths agree on the release root', t => {
  const { root } = fixture(t);
  const workflow = parse(fs.readFileSync(path.join(project, '.github/workflows/release.yml'), 'utf8'));
  const steps = workflow.jobs.build.steps;
  assert.equal(steps.find(s => s.name === 'Build Windows packages').run, 'node build/guarded-distribution.cjs');
  const invocation = steps.find(s => s.name === 'Verify final installer payloads exclude development matchers').run;
  const resolved = verificationPaths(root, invocation.trim().split(/\s+/).slice(2));
  assert.equal(resolved.output, path.join(root, 'release'));
  assert.equal(resolved.report, path.join(root, '.risk-build/strict-release/artifact-verification.json'));
  const manifest = JSON.parse(fs.readFileSync(path.join(project, 'package.json')));
  assert.equal(manifest.build.directories.output, 'release');
  const upload = steps.find(s => s.with?.name === 'N7M-Windows-x64');
  const release = workflow.jobs.release.steps;
  const download = release.find(s => s.uses?.startsWith('actions/download-artifact@'));
  assert.equal(download.with.path, 'release'); assert.equal(download.with.name, upload.with.name);
  const patterns = upload.with.path.trim().split(/\s*\n\s*/);
  assert.deepEqual(patterns, ['release/*-Setup.exe', 'release/*-Portable.exe', 'release/*-NoInstall.zip']);
  assert.equal(release.find(s => s.uses?.startsWith('softprops/action-gh-release@')).with.files.trim(), upload.with.path.trim());
});
