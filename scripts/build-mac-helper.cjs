'use strict';
const {spawnSync}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
if(process.platform!=='darwin') {console.error('Run this on macOS with Xcode command-line tools.');process.exit(1);}
const project=path.resolve(__dirname,'..');
const source=path.join(project,'src','native','macos-input.swift');
const output=path.join(project,'src','native','macos-input');
function run(command,args) {
  const result=spawnSync(command,args,{encoding:'utf8',timeout:120000});
  if(result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message || result.stderr || result.stdout}`);
  return result.stdout.trim();
}
try {
  const compiler=run('swiftc',['--version']);
  run('swiftc',['-O','-whole-module-optimization','-target','arm64-apple-macos13.0',source,'-framework','ApplicationServices','-framework','AppKit','-o',output]);
  fs.chmodSync(output,0o755);
  run('lipo',[output,'-verify_arch','arm64']);
  run('codesign',['--force','--sign','-',output]);
  const selfTest=JSON.parse(run(output,['--self-test']));
  assert.equal(selfTest.passed,true);
  assert.equal(selfTest.inputPosted,false);
  assert.ok(selfTest.clickTrackingChecks>=25);assert.ok(selfTest.quartzClickFieldChecks>=22);
  const out=path.join(project,'test-results');fs.mkdirSync(out,{recursive:true});
  fs.writeFileSync(path.join(out,'mac-helper-build.json'),JSON.stringify({passed:true,architecture:'arm64',minimumSystemVersion:'13.0',compiler,selfTest,signing:'ad-hoc; no Developer ID or notarization'},null,2));
  console.log(`Compiled and checked arm64 native helper (${selfTest.checks} safe checks, no input posted).`);
} catch(error) {console.error(error.message);process.exitCode=1;}
