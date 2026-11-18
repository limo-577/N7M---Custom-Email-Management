const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parse } = require('yaml');
const { parseArguments } = require('./build-windows.cjs');
const root = path.resolve(__dirname, '..');
const workflowDirectory = path.join(root, '.github/workflows');
const workflows = Object.fromEntries(fs.readdirSync(workflowDirectory)
  .filter(name => /\.ya?ml$/.test(name))
  .map(name => [name, parse(fs.readFileSync(path.join(workflowDirectory, name), 'utf8'))]));
const workflow = workflows['release.yml'];
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('all CI actions use full commit SHAs and builds retain only read permissions', () => {
  assert.deepEqual(workflow.jobs.build.permissions, { contents: 'read' });
  for (const [name, configuration] of Object.entries(workflows)) {
    assert.deepEqual(configuration.permissions, { contents: 'read' });
    for (const [id, job] of Object.entries(configuration.jobs)) {
      if (name !== 'release.yml' || id !== 'release') assert.deepEqual(job.permissions, { contents: 'read' });
      for (const step of job.steps) {
        if (step.uses) assert.match(step.uses, /^[\w-]+\/[\w-]+@[a-f0-9]{40}$/, `Unpinned action: ${step.uses}`);
        if (step.uses?.startsWith('actions/checkout@')) assert.equal(step.with['persist-credentials'], false);
      }
    }
  }
  const checkout = workflow.jobs.build.steps.find(step => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with['persist-credentials'], false);
  assert.equal(workflow.jobs.build.steps.some(step => step.uses?.startsWith('softprops/action-gh-release@')), false);
});

test('write permissions are isolated to tag-push publication of the same run artifact', () => {
  const release = workflow.jobs.release;
  assert.equal(release.needs, 'build');
  assert.equal(release.if, "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')");
  assert.deepEqual(release.permissions, { contents: 'write' });
  assert.ok(release.steps.every(step => !step.run && !step.uses?.startsWith('actions/checkout@')));
  assert.equal(release.steps.length, 2, 'Only artifact download and release upload may use the write token');
  const upload = workflow.jobs.build.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
  const download = release.steps.find(step => step.uses?.startsWith('actions/download-artifact@'));
  assert.equal(download.with.name, upload.with.name);
  assert.equal(download.with.path, 'release');
  for (const key of ['repository', 'run-id', 'github-token', 'pattern']) assert.equal(Object.hasOwn(download.with, key), false);
  const publish = release.steps.find(step => step.uses?.startsWith('softprops/action-gh-release@'));
  assert.equal(publish.uses, 'softprops/action-gh-release@efb35369e0ad2afab669f228072c1b0d510eae64', 'Use the reviewed supported v3.0.3 publisher');
  assert.equal(publish.with['fail_on_unmatched_files'], true);
  assert.equal(publish.with.files.trim(), upload.with.path.trim());
  assert.equal(upload.with['if-no-files-found'], 'error');
  assert.equal(upload.with['retention-days'], 30);
});

test('workflow npm build command and manifest targets are accepted by the actual Windows wrapper', () => {
  const buildStep = workflow.jobs.build.steps.find(step => step.name === 'Build Windows packages');
  // Fail if workflow arguments diverge from the wrapper again (for example,
  // forwarding unsupported --publish never from a previous electron-builder CLI).
  const invocation = /^npm run (dist(?::[\w-]+)?)(?: -- (.+))?$/.exec(buildStep.run.trim());
  assert.ok(invocation, 'CI must use a known npm distribution script');
  const script = manifest.scripts[invocation[1]];
  const wrapper = /^npm run build && node build\/build-windows\.cjs(?: (.*))?$/.exec(script);
  assert.ok(wrapper, 'Distribution script must invoke the reviewed build wrapper');
  const args = [wrapper[1], invocation[2]].filter(Boolean).join(' ').trim().split(/\s+/).filter(Boolean);
  assert.deepEqual(parseArguments(args).targetNames, ['nsis', 'portable', 'zip']);
  assert.ok(workflow.jobs.build.steps.some(step => step.run === 'npm test'));
});

test('release builds gate on accepted-risk policy and current vulnerability audit after installation', () => {
  const steps = workflow.jobs.build.steps;
  const install = steps.findIndex(step => step.run === 'npm ci');
  const policy = steps.findIndex(step => step.run === 'npm run check:dependencies');
  const audit = steps.findIndex(step => step.run === 'npm audit --audit-level=low');
  const build = steps.findIndex(step => step.run === 'npm run dist:all');
  assert.ok(install >= 0 && install < policy && policy < audit && audit < build);
  assert.equal(steps[audit].if, '${{ !cancelled() }}');
});

test('weekly dependency review is read-only and never builds, publishes or sends messages', () => {
  const review = workflows['dependency-review.yml'];
  assert.deepEqual(Object.keys(review.on).sort(), ['schedule', 'workflow_dispatch']);
  assert.deepEqual(review.on.schedule, [{ cron: '13 7 * * 1' }]);
  assert.equal(Object.keys(review.jobs).length, 1);
  const job = review.jobs.check;
  assert.deepEqual(job.permissions, { contents: 'read' });
  const commands = job.steps.filter(step => step.run).map(step => step.run);
  assert.deepEqual(commands, ['npm ci', 'npm run check:dependencies:online', 'npm audit --audit-level=low']);
  const actions = job.steps.filter(step => step.uses).map(step => step.uses.split('@')[0]);
  assert.deepEqual(actions, ['actions/checkout', 'actions/setup-node']);
});
