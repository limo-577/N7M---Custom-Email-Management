'use strict';
function checkReleaseVersion(manifest, lock, { event, ref } = {}) {
  const version = manifest.version;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) ||
    lock.version !== version || lock.packages?.['']?.version !== version) throw Error('Manifest and lockfile release versions must agree');
  if ((event === 'push' || ref?.startsWith('refs/tags/')) && ref !== `refs/tags/v${version}`) throw Error('Release tag must match the committed software version');
  return version;
}
module.exports = { checkReleaseVersion };
if (require.main === module) {
  try {
    if (process.argv.length !== 2) throw Error('No version overrides are accepted');
    const version = checkReleaseVersion(require('../package.json'), require('../package-lock.json'), { event: process.env.GITHUB_EVENT_NAME, ref: process.env.GITHUB_REF });
    console.log(`Release version ${version} matches the lockfile and any triggering tag.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
