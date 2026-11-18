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
      if (name === 'controlled-build.yml') assert.deepEqual(job.permissions, { contents: 'read', actions: 'read' });
      else if (name !== 'release.yml' || id !== 'release') assert.deepEqual(job.permissions, { contents: 'read' });
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
  const audit = steps.findIndex(step => step.run === 'npm audit --audit-level=low --json > npm-audit-raw.json');
  const build = steps.findIndex(step => step.run === 'npm run dist:all');
  assert.ok(install >= 0 && install < policy && policy < audit && audit < build);
  assert.equal(steps[audit].if, '${{ !cancelled() }}');
  const verify = steps.findIndex(step => step.run === 'node build/verify-release.cjs --output release --report .risk-build/strict-release/artifact-verification.json');
  const upload = steps.findIndex(step => step.with?.name === 'N7M-Windows-x64');
  assert.ok(build < verify && verify < upload);
});

test('weekly dependency review is read-only and never builds, publishes or sends messages', () => {
  const review = workflows['dependency-review.yml'];
  assert.deepEqual(Object.keys(review.on).sort(), ['schedule', 'workflow_dispatch']);
  assert.deepEqual(review.on.schedule, [{ cron: '13 7 * * 1' }]);
  assert.equal(Object.keys(review.jobs).length, 1);
  const job = review.jobs.check;
  assert.deepEqual(job.permissions, { contents: 'read' });
  const commands = job.steps.filter(step => step.run).map(step => step.run);
  assert.deepEqual(commands, ['npm install --global npm@11.6.2 --ignore-scripts', 'npm ci', 'npm run check:dependencies:online', 'npm audit --audit-level=low --json > npm-audit-raw.json']);
  const actions = job.steps.filter(step => step.uses).map(step => step.uses.split('@')[0]);
  assert.deepEqual(actions, ['actions/checkout', 'actions/setup-node', 'actions/upload-artifact']);
});

test('CI uses the locally verified toolchain and preserves failed raw audit reports', () => {
  for (const configuration of Object.values(workflows)) {
    for (const job of Object.values(configuration.jobs)) {
      const setup = job.steps.find(step => step.uses?.startsWith('actions/setup-node@'));
      if (!setup) continue;
      assert.equal(setup.with['node-version'], '24.13.0');
      assert.ok(job.steps.some(step => step.run === 'npm install --global npm@11.6.2 --ignore-scripts'));
      if (configuration === workflows['controlled-build.yml']) continue;
      const evidence = job.steps.find(step => step.with?.path?.split(/\s+/).includes('npm-audit-raw.json'));
      assert.equal(evidence.if, '${{ !cancelled() }}');
      assert.equal(evidence.with['if-no-files-found'], 'error');
      assert.ok(job.steps.every(step => !step['continue-on-error']));
    }
  }
  assert.ok(workflow.jobs.build.steps.some(step => step.run === 'git diff --exit-code -- package.json package-lock.json'));
  const steps = workflow.jobs.build.steps;
  const runtimeInstall = steps.findIndex(step => step.run === 'node node_modules/electron/install.js');
  assert.ok(runtimeInstall >= 0 && runtimeInstall < steps.findIndex(step => step.run === 'npm test'));
  for (const candidate of [workflow.jobs.build, workflows['controlled-build.yml'].jobs.build]) {
    const preserve = candidate.steps.findIndex(step => step.run === 'git config --global core.autocrlf false');
    const checkout = candidate.steps.findIndex(step => step.uses?.startsWith('actions/checkout@'));
    assert.ok(preserve >= 0 && preserve < checkout, 'Windows checkouts must preserve canonical reviewed source bytes');
  }
  const isolated = steps.find(step => step.run === 'npm run --silent check:picomatch > picomatch-probes.json');
  assert.equal(isolated.if, '${{ !cancelled() }}');
});

test('verification packages can use a separate output without overwriting previous releases', () => {
  assert.equal(parseArguments(['nsis', '--output', 'release/security-review']).output, path.join(root, 'release/security-review'));
  assert.throws(() => parseArguments(['--output']), /requires a directory/);
});

test('exception workflow is manual, strict by default, independently protected and never publishes', () => {
  const controlled = workflows['controlled-build.yml'];
  assert.deepEqual(Object.keys(controlled.on), ['workflow_dispatch']);
  assert.equal(controlled.on.workflow_dispatch.inputs.mode.default, 'strict');
  const job = controlled.jobs.build;
  assert.match(job.environment, /picomatch-risk-acceptance/);
  assert.match(job.if, /github.repository.*limo-577.*refs\/heads\/main/);
  const preflight = job.steps.findIndex(step => step.name === 'Authenticate one-run approval before checkout');
  const checkout = job.steps.findIndex(step => step.uses?.startsWith('actions/checkout@'));
  assert.ok(preflight >= 0 && preflight < checkout);
  for (const requirement of ['crypto.verify', 'GITHUB_SHA', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'prevent_self_review', 'response.ok']) assert.ok(job.steps[preflight].run.includes(requirement));
  assert.equal(job.steps[checkout].with.ref, '${{ github.sha }}');
  assert.equal(job.steps[checkout].with.submodules, false);
  assert.equal(job.steps.some(step => step.uses?.startsWith('softprops/')), false);
  assert.ok(job.steps.filter(step => step.run).every(step => !step.run.includes('npm audit --omit=dev --json > npm-audit-raw.json')));
  const guide = fs.readFileSync(path.join(root, 'docs/GITHUB_RELEASE_SETUP.md'), 'utf8');
  const contract = JSON.parse(fs.readFileSync(path.join(root, 'security-audit/release-preparation/workflow-contract.json'), 'utf8'));
  assert.deepEqual(contract.release.environments, [], 'The strict publisher currently declares no environment');
  assert.ok(Object.values(workflow.jobs).every(value => value.environment === undefined));
  for (const expression of Object.values(job.steps[preflight].env)) {
    const name = /(?:vars|secrets)\.(N7M_[A-Z_]+)/.exec(expression)?.[1];
    if (name) assert.ok(guide.includes(`\`${name}\``), `Missing exact setting in administrator guide: ${name}`);
  }
  assert.equal(contract.controlled.environmentExpression, job.environment);
  assert.equal(contract.controlled.preflightEnvironment.RISK_PUBLIC_KEY.name, 'N7M_RISK_PUBLIC_KEY');
});
