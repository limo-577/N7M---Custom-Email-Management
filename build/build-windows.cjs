'use strict';
// electron-builder 26.18.0 does not expose a custom portable script option.
// Replace the template only inside this build process; never modify node_modules.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PINNED_BUILDER = '26.18.0';
async function runtimeBuildHash(archs) {
  const hash = crypto.createHash('sha256');
  // Cache identity includes launcher behavior as well as executable payload so
  // a same-version launcher repair never trusts an older generation's marker.
  hash.update(fs.readFileSync(path.join(__dirname, 'portable-fast.nsi')));
  for (const [arch, directory] of [...archs].sort(([left], [right]) => left - right)) {
    hash.update(`arch:${arch}\0`);
    const visit = async (relative = '') => {
      const entries = await fs.promises.readdir(path.join(directory, relative), { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
      for (const entry of entries) {
        const file = path.join(relative, entry.name);
        if (entry.isDirectory()) await visit(file);
        else if (entry.isFile()) {
          const stat = await fs.promises.stat(path.join(directory, file));
          hash.update(`${file.replace(/\\/g, '/')}\0${stat.size}\0`);
          for await (const chunk of fs.createReadStream(path.join(directory, file))) hash.update(chunk);
        } else throw new Error('Portable runtime must not contain links or special files');
      }
    };
    await visit();
  }
  return hash.digest('hex');
}
function installPortableTemplate() {
  // Load the public entry point first; deep-loading NsisTarget directly enters
  // app-builder-lib's platform-packager dependency cycle before initialization.
  require('electron-builder');
  const version = require('app-builder-lib/package.json').version;
  if (version !== PINNED_BUILDER) throw new Error(`Portable launcher adapter expects app-builder-lib ${PINNED_BUILDER}, found ${version}. Review its NSIS integration before updating.`);
  const { NsisTarget } = require('app-builder-lib/out/targets/nsis/NsisTarget');
  const prototype = NsisTarget.prototype;
  const original = prototype.computeFinalScript;
  if (typeof original !== 'function' || !Object.getOwnPropertyDescriptor(prototype, 'isPortable')?.get || !original.toString().includes('if (this.isPortable)')) throw new Error('Unsupported electron-builder portable template integration');
  if (original.n7mPortableAdapter) return;
  const source = fs.readFileSync(path.join(__dirname, 'portable-fast.nsi'), 'utf8').replace(/^\uFEFF/, '');
  const replacement = async function(originalScript, isInstaller, archs) {
    if (this.isPortable) {
      if (!originalScript.includes('PORTABLE_EXECUTABLE_DIR') || !originalScript.includes('RMDir /r $INSTDIR')) throw new Error('The upstream portable template changed; review the N7M adapter');
      const buildHash = await runtimeBuildHash(archs);
      return original.call(this, `!define N7M_BUILD_HASH "${buildHash}"\n${source}`, isInstaller, archs);
    }
    return original.call(this, originalScript, isInstaller, archs);
  };
  replacement.n7mPortableAdapter = true;
  prototype.computeFinalScript = replacement;
}
function parseArguments(args) {
  const targetNames = [];
  let prepackaged;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--prepackaged') {
      if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error('--prepackaged requires a directory');
      prepackaged = path.resolve(args[++index]);
    } else if (['nsis', 'portable', 'zip', 'dir'].includes(argument)) targetNames.push(argument);
    else throw new Error(`Unsupported build argument: ${argument}`);
  }
  return { targetNames: targetNames.length ? [...new Set(targetNames)] : ['nsis', 'portable', 'zip'], prepackaged };
}
async function main(args = process.argv.slice(2)) {
  const { targetNames, prepackaged } = parseArguments(args);
  installPortableTemplate();
  const { build, Platform, Arch } = require('electron-builder');
  return build({ targets: Platform.WINDOWS.createTarget(targetNames, Arch.x64), publish: 'never', ...(prepackaged ? { prepackaged } : {}) });
}
module.exports = { installPortableTemplate, parseArguments, runtimeBuildHash, main };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
