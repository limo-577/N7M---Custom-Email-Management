const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {parseArguments,runtimeBuildHash,installPortableTemplate}=require('./build-windows.cjs');
function fixture(){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'n7m-launcher-hash-'));
 return {directory,cleanup(){const absolute=path.resolve(directory);assert.ok(absolute.startsWith(path.join(path.resolve(os.tmpdir()),'n7m-launcher-hash-')));fs.rmSync(absolute,{recursive:true,force:true});}};
}
test('build wrapper preserves target choices and validates prepackaged arguments',()=>{
 assert.deepEqual(parseArguments([]).targetNames,['nsis','portable','zip']);
 assert.deepEqual(parseArguments(['portable','zip','portable']).targetNames,['portable','zip']);
 assert.equal(parseArguments(['portable','--prepackaged','release/win-unpacked']).prepackaged,path.resolve('release/win-unpacked'));
 assert.throws(()=>parseArguments(['--prepackaged']),/requires a directory/);
 assert.throws(()=>parseArguments(['--publish']),/Unsupported/);
});
test('same-version runtime changes invalidate cache identity without relying on timestamps',async()=>{
 const {directory,cleanup}=fixture();
 try{
  fs.mkdirSync(path.join(directory,'resources'));fs.writeFileSync(path.join(directory,'resources','app.asar'),'first');
  fs.writeFileSync(path.join(directory,'runtime.exe'),'runtime');
  const architecture=new Map([[1,directory]]);const original=await runtimeBuildHash(architecture);
  assert.match(original,/^[a-f0-9]{64}$/);assert.equal(await runtimeBuildHash(architecture),original);
  fs.utimesSync(path.join(directory,'runtime.exe'),new Date(),new Date());assert.equal(await runtimeBuildHash(architecture),original);
  fs.writeFileSync(path.join(directory,'resources','app.asar'),'other');assert.notEqual(await runtimeBuildHash(architecture),original);
 }finally{cleanup();}
});
test('runtime cache hashing is deterministic for directory enumeration order',async()=>{
 const left=fixture(),right=fixture();
 try{
  fs.writeFileSync(path.join(left.directory,'z.dat'),'z');fs.writeFileSync(path.join(left.directory,'a.dat'),'a');
  fs.writeFileSync(path.join(right.directory,'a.dat'),'a');fs.writeFileSync(path.join(right.directory,'z.dat'),'z');
  assert.equal(await runtimeBuildHash(new Map([[1,left.directory]])),await runtimeBuildHash(new Map([[1,right.directory]])));
 }finally{left.cleanup();right.cleanup();}
});
test('portable template extension is process-local, pinned and idempotent',()=>{
 installPortableTemplate();const {NsisTarget}=require('app-builder-lib/out/targets/nsis/NsisTarget');
 const patched=NsisTarget.prototype.computeFinalScript;assert.equal(patched.n7mPortableAdapter,true);
 installPortableTemplate();assert.equal(NsisTarget.prototype.computeFinalScript,patched);
});
