'use strict';

// Run against the actual distributable DMG on an Apple Silicon Mac. This check
// never asks for microphone/camera/capture/Accessibility permission or injects
// input. Hardware calls and attended input still require real-device testing.
const { _electron } = require('playwright');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const asar = require('@electron/asar');
const project = path.resolve(__dirname,'..');
const pkg = require(path.join(project,'package.json'));
const evidence = path.join(project,'test-results');

function command(file,args,input) {
  const result=spawnSync(file,args,{encoding:'utf8',input,timeout:120000});
  if(result.error || result.status !== 0) throw new Error(`${file} failed: ${result.error?.message || result.stderr || result.stdout}`);
  return result.stdout.trim();
}
function plistJSON(value) { return JSON.parse(command('plutil',['-convert','json','-o','-','-'],value)); }
function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function health(origin) {
  return new Promise((resolve,reject)=>{
    const request=https.get(`${origin}/health`,{rejectUnauthorized:false,agent:false,timeout:5000},response=>{
      const raw=response.socket.getPeerCertificate(true).raw;
      let data='';response.on('data',part=>data+=part);response.on('end',()=>{
        try {assert.equal(response.statusCode,200);resolve({body:JSON.parse(data),pin:hash(raw)});} catch(error){reject(error);}
      });
    });
    request.on('timeout',()=>request.destroy(new Error('Local packaged room timed out')));request.on('error',reject);
  });
}

async function main() {
  assert.equal(process.platform,'darwin','Run this check on macOS');
  assert.equal(process.arch,'arm64','This test artifact targets Apple Silicon');
  fs.mkdirSync(evidence,{recursive:true});
  const dmg=path.join(project,'release',`Auralink-${pkg.version}-Mac-arm64.dmg`);
  assert.ok(fs.existsSync(dmg),'Build the DMG before bundle verification');
  command('hdiutil',['verify',dmg]);
  const mounted=plistJSON(command('hdiutil',['attach','-readonly','-nobrowse','-plist',dmg]));
  const volume=mounted['system-entities'].map(entry=>entry['mount-point']).find(point=>point && fs.existsSync(path.join(point,'Auralink.app')));
  assert.ok(volume,'DMG must contain the Auralink application');
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'auralink-mac-ci-'));
  let application;
  try {
    const appBundle=path.join(volume,'Auralink.app');
    const binary=path.join(appBundle,'Contents','MacOS','Auralink');
    const resources=path.join(appBundle,'Contents','Resources');
    const helper=path.join(resources,'app.asar.unpacked','src','native','macos-input');
    const metadata=JSON.parse(command('plutil',['-convert','json','-o','-',path.join(appBundle,'Contents','Info.plist')]));
    assert.equal(metadata.CFBundleIdentifier,'local.auralink.desktop');
    assert.equal(metadata.CFBundleShortVersionString,pkg.version);
    for(const usage of ['NSMicrophoneUsageDescription','NSCameraUsageDescription','NSScreenCaptureUsageDescription','NSLocalNetworkUsageDescription']) assert.ok(metadata[usage]?.length>10,`${usage} must explain the local action`);
    command('lipo',['-verify_arch','arm64',binary]);command('lipo',['-verify_arch','arm64',helper]);
    command('codesign',['--verify','--deep','--strict',appBundle]);
    const selfTest=JSON.parse(command(helper,['--self-test']));
    assert.equal(selfTest.passed,true);assert.equal(selfTest.inputPosted,false);
    const permissions=JSON.parse(command(helper,['--check-permissions']));
    assert.equal(permissions.inputPosted,false);
    const archive=path.join(resources,'app.asar');
    const sourceFiles=['src/main.cjs','src/preload.cjs','src/core/broker.cjs','src/core/invite.cjs','src/native/control.cjs','src/native/macos-input.swift',
      'src/renderer/index.html','src/renderer/styles.css','src/renderer/app.js','src/renderer/rtc.js','src/renderer/android-bridge.js'];
    for(const file of sourceFiles) assert.equal(hash(asar.extractFile(archive,file)),hash(fs.readFileSync(path.join(project,file))),`${file} must match the tested source`);
    const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
    application=await _electron.launch({executablePath:binary,args:['--smoke-test',`--user-data-dir=${profile}`],env,timeout:60000});
    const page=await application.firstWindow();
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.waitForSelector('#host-button');
    const info=await page.evaluate(()=>window.auralink.getInfo());
    assert.equal(info.platform,'darwin');assert.equal(info.version,pkg.version);assert.equal(info.nativeControl,true);assert.equal(info.testing,true);
    await page.screenshot({path:path.join(evidence,'mac-lobby.png')});
    const room=await page.evaluate(()=>window.auralink.hostRoom({name:'Mac bundle verification'}));
    const response=await health(room.url);assert.equal(response.pin,room.fingerprint);
    await page.evaluate(()=>window.auralink.stopRoom());
    await assert.rejects(health(room.url));
    assert.deepEqual(errors,[]);
    const results={passed:true,version:pkg.version,architecture:'arm64',dmg:path.basename(dmg),sha256:hash(fs.readFileSync(dmg)),
      checks:['DMG integrity and mounted application','arm64 app and unpacked input helper','bundle usage descriptions','deep strict code signature verification',
        'packaged source hashes match','safe native helper self-test','actual packaged Electron renderer launch','pinned local HTTPS room starts and stops'],
      permissions:info.permissions,helperSelfTest:selfTest,signing:'ad-hoc testing build; no Developer ID or notarization',
      physicalDeviceTesting:'Not performed by this check. Camera, microphone, screen capture and attended input require Mac owner permission and real-device testing.'};
    fs.writeFileSync(path.join(evidence,'mac-bundle-smoke.json'),JSON.stringify(results,null,2));
    console.log('Mac DMG verified: actual arm64 bundle, renderer, native helper, source and local TLS room. No hardware permission or remote input was requested.');
  } finally {
    if(application) await application.close();
    command('hdiutil',['detach',volume]);
    fs.rmSync(profile,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
