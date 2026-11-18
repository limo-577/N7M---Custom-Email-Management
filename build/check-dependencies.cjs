const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const EXCELJS_ENDPOINT = 'https://registry.npmjs.org/exceljs-hardened/latest';
function packageName(installationPath, entry) {
  // npm aliases retain the real package name in the lockfile. In particular,
  // minimatch-engine is official minimatch, not the compatibility package.
  return entry.name || installationPath.split('node_modules/').at(-1);
}
function currentDate(timezone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}
function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
function checkPolicy({ lock, manifest, policy, today }) {
  const errors = [];
  if (policy.schemaVersion !== 1 || !validDate(policy.acceptedOn) || !validDate(policy.reviewBy) || policy.reviewBy <= policy.acceptedOn) {
    return { ok: false, errors: ['Dependency policy dates/schema are invalid; developer review is required.'], deprecatedCount: 0 };
  }
  if (!lock?.packages || ![2, 3].includes(lock.lockfileVersion)) {
    return { ok: false, errors: ['A supported package-lock.json with packages is required.'], deprecatedCount: 0 };
  }
  const reviewDate = today || currentDate(policy.timezone);
  if (!validDate(reviewDate)) throw new Error('Invalid current date');
  if (reviewDate >= policy.reviewBy) errors.push(`Dependency maintenance review is due (${policy.reviewBy}). Review upstream releases and renew or replace the accepted exceptions with developer approval.`);
  const accepted = new Map();
  for (const entry of policy.deprecatedExceptions || []) {
    if (!entry.path?.startsWith('node_modules/') || !entry.version || !entry.reason || accepted.has(entry.path)) {
      errors.push('Deprecated exceptions must have distinct installation paths, exact versions and reasons.');
    } else accepted.set(entry.path, entry);
  }
  let deprecatedCount = 0;
  for (const [installationPath, entry] of Object.entries(lock.packages)) {
    if (!installationPath) continue;
    const exception = accepted.get(installationPath);
    if (entry.deprecated) {
      deprecatedCount++;
      if (!exception || exception.version !== entry.version) errors.push(`Unreviewed deprecated package: ${installationPath}@${entry.version}. Review its maintenance risk before changing the policy.`);
    }
    // A version/path change must be reviewed even if its deprecation metadata
    // disappeared; deleting that flag must not silently remove the follow-up.
    if (exception && exception.version !== entry.version) errors.push(`Accepted exception changed: ${installationPath} expected ${exception.version}, found ${entry.version}.`);
  }
  for (const entry of accepted.values()) {
    if (!lock.packages[entry.path]) errors.push(`Accepted exception no longer exists at ${entry.path}; confirm its removal/relocation and update the policy.`);
    else if (!lock.packages[entry.path].deprecated) errors.push(`Deprecation metadata changed for ${entry.path}; verify upstream status and update the policy explicitly.`);
  }
  for (const pin of policy.protectedPackages || []) {
    const versions = Object.entries(lock.packages).filter(([key, entry]) => key && packageName(key, entry) === pin.name);
    if (!versions.length) errors.push(`Protected dependency is missing: ${pin.name}.`);
    for (const [installationPath, entry] of versions) {
      if (!pin.versions.includes(entry.version)) errors.push(`Protected dependency changed: ${installationPath}@${entry.version}; allowed: ${pin.versions.join(', ')}. Review compatibility and advisories before updating the pin.`);
    }
  }
  for (const [key, expected] of Object.entries(policy.manifestPins || {})) {
    const actual = key.split('.').reduce((value, part) => value?.[part], manifest);
    if (actual !== expected) errors.push(`Manifest pin changed: ${key} must remain ${expected} until reviewed.`);
  }
  return { ok: !errors.length, errors, deprecatedCount, reviewBy: policy.reviewBy };
}

async function checkUpstream(policy, { fetchImpl = globalThis.fetch } = {}) {
  // Keep the endpoint fixed in code: policy data must not redirect this tool to
  // arbitrary hosts. Registry outages are actionable failures, not silent passes.
  if (policy.exceljsMaintenance?.registryEndpoint !== EXCELJS_ENDPOINT) return ['exceljs-hardened registry endpoint must remain the official npm registry endpoint.'];
  try {
    const response = await fetchImpl(EXCELJS_ENDPOINT, {
      headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const latest = await response.json();
    if (latest.name !== 'exceljs-hardened' || typeof latest.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(latest.version)) throw new Error('invalid registry metadata');
    const errors = [];
    if (latest.version !== policy.exceljsMaintenance.acceptedVersion) errors.push(`exceljs-hardened upstream now reports ${latest.version}; accepted version is ${policy.exceljsMaintenance.acceptedVersion}. Review the official release and migration compatibility; no package was installed or upgraded.`);
    if (latest.deprecated) errors.push('The official exceljs-hardened release is now marked deprecated. Review migration or renew explicit risk acceptance.');
    return errors;
  } catch (error) {
    return [`Cannot verify the official npm exceljs-hardened release (${error.message}). Retry the online check; upstream status is not confirmed.`];
  }
}

async function main(args = process.argv.slice(2)) {
  if (args.some(arg => arg !== '--online') || args.length > 1) throw new Error('Usage: node build/check-dependencies.cjs [--online]');
  const policy = JSON.parse(fs.readFileSync(path.join(ROOT, 'security-audit/dependency-policy.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const result = checkPolicy({ lock, manifest, policy });
  if (args.includes('--online')) result.errors.push(...await checkUpstream(policy));
  result.ok = !result.errors.length;
  if (!result.ok) {
    console.error('Dependency policy check FAILED:');
    for (const error of result.errors) console.error(`- ${error}`);
    process.exitCode = 1;
  } else {
    console.log(`Dependency policy check passed. ${result.deprecatedCount} existing deprecated packages remain explicitly accepted until review on ${result.reviewBy}.`);
    console.log(`exceljs-hardened ${policy.exceljsMaintenance.acceptedVersion} maintenance risk remains accepted; ${args.includes('--online') ? 'official npm release checked' : 'offline lockfile validation only'}. Run npm audit separately; no audit result is filtered.`);
  }
}
if (require.main === module) main().catch(error => { console.error(`Dependency policy check FAILED: ${error.message}`); process.exitCode = 1; });
module.exports = { checkPolicy, checkUpstream, packageName };
