'use strict';

// Run against the actual distributable DMG on an Apple Silicon Mac. This check
// never asks for microphone/capture/Accessibility permission or injects
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
function signedEntitlements(bundle) {
  // Apple's documented extraction command explicitly requests XML; modern
  // codesign otherwise need not return a plist suitable for plutil.
  const result=spawnSync('codesign',['--display','--entitlements','-','--xml',bundle],{encoding:'utf8',timeout:120000});
  if(result.error || result.status!==0) throw new Error(`Read signed bundle entitlements failed: ${result.error?.message || result.stderr}`);
  // Current codesign can omit the optional XML declaration. The plist itself,
  // including its closing tag, is required; an absent entitlement still fails.
  const xml=`${result.stdout}\n${result.stderr}`.match(/<plist\b[\s\S]*?<\/plist>/)?.[0];
  assert.ok(xml,`Signed bundle must expose its actual entitlements: ${path.basename(bundle)}; ${`${result.stdout}\n${result.stderr}`.slice(0,400)}`);
  return plistJSON(xml);
}
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
    for(const usage of ['NSMicrophoneUsageDescription','NSScreenCaptureUsageDescription','NSLocalNetworkUsageDescription']) assert.ok(metadata[usage]?.length>10,`${usage} must explain the local action`);
    assert.equal(metadata.NSCameraUsageDescription, undefined, 'Screen-only app must not declare camera capture');
    assert.ok(metadata.CFBundleURLTypes?.some(item => item.CFBundleURLSchemes?.includes('auralink')), 'Installed room links must register the auralink scheme');
    command('lipo',[binary,'-verify_arch','arm64']);command('lipo',[helper,'-verify_arch','arm64']);
    command('codesign',['--verify','--deep','--strict',appBundle]);
    // The capture/audio service can run in the generic Electron helper. Check
    // both actual signatures, rather than only the intended build plist.
    const microphoneEntitlements=[appBundle,path.join(appBundle,'Contents','Frameworks','Auralink Helper.app')].map(bundle=>{
      assert.ok(fs.existsSync(bundle),'The signed audio service helper must be bundled');
      const entitlements=signedEntitlements(bundle);
      assert.equal(entitlements['com.apple.security.device.audio-input'],true,'Signed app and audio helper must permit microphone input under hardened runtime');
      assert.equal(entitlements['com.apple.security.device.camera'],undefined,'Screen-only app must not carry a camera entitlement');
      return {bundle:path.basename(bundle),audioInput:true,camera:false};
    });
    const selfTest=JSON.parse(command(helper,['--self-test']));
    assert.equal(selfTest.passed,true);assert.equal(selfTest.inputPosted,false);
    assert.ok(selfTest.clickTrackingChecks>=25);assert.ok(selfTest.quartzClickFieldChecks>=22);
    const permissions=JSON.parse(command(helper,['--check-permissions']));
    assert.equal(permissions.inputPosted,false);
    const archive=path.join(resources,'app.asar');
    const sourceFiles=['src/main.cjs','src/preload.cjs','src/core/broker.cjs','src/core/invite.cjs','src/native/control.cjs','src/native/macos-input.swift',
      'src/renderer/index.html','src/renderer/styles.css','src/renderer/app.js','src/renderer/rtc.js','src/renderer/android-bridge.js',
      'src/renderer/internet.js','src/renderer/desktop-internet.js','src/core/internet-client.cjs','src/core/app-invitation.cjs','src/renderer/relay-media.js','src/renderer/audio-worklet.js'];
    const sourceParity=sourceFiles.map(file=>{const packagedSha256=hash(asar.extractFile(archive,file)),sourceSha256=hash(fs.readFileSync(path.join(project,file)));assert.equal(packagedSha256,sourceSha256,`${file} must match the tested source`);return {path:file,packagedSha256,sourceSha256,matches:true};});
    const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
    const coldCode=`A1.${crypto.randomUUID()}.${crypto.randomBytes(32).toString('base64url')}`;
    application=await _electron.launch({executablePath:binary,args:['--smoke-test',`--user-data-dir=${profile}`,`auralink://join#code=${coldCode}`],env,timeout:60000});
    const page=await application.firstWindow();
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.waitForSelector('#host-button');
    await page.waitForFunction(code=>document.getElementById('quick-join-invite').value===code,coldCode);
    assert.equal(await page.evaluate(()=>window.auralink.getPendingInvitation()),null,'Cold invitation is consumed once by the renderer');
    if(await page.locator('#cancel-room-start').isVisible()) await page.locator('#cancel-room-start').click();
    await page.waitForFunction(()=>!document.getElementById('host-button').disabled);
    const originalPage=page.url();
    const warmCode=`A1.${crypto.randomUUID()}.${crypto.randomBytes(32).toString('base64url')}`;
    // Exercise the packaged main-process open-url event and the real isolated
    // preload. Stop this deliberately nonexistent QA invitation before any
    // admission request; this does not prove global LaunchServices routing.
    await page.evaluate(()=>document.getElementById('quick-join-form').addEventListener('submit',event=>{event.preventDefault();event.stopImmediatePropagation();},{capture:true,once:true}));
    await application.evaluate(({app},code)=>app.emit('open-url',{preventDefault(){}},`auralink://join#code=${code}`),warmCode);
    await page.waitForFunction(code=>document.getElementById('quick-join-invite').value===code,warmCode);
    assert.equal(page.url(),originalPage);
    assert.equal(await page.evaluate(()=>window.auralink.getPendingInvitation()),warmCode);
    assert.equal(await page.evaluate(()=>window.auralink.getPendingInvitation()),null);
    await page.locator('#quick-join-invite').fill('');
    const info=await page.evaluate(()=>window.auralink.getInfo());
    assert.equal(info.platform,'darwin');assert.equal(info.version,pkg.version);assert.equal(info.nativeControl,true);assert.equal(info.testing,true);
    await page.screenshot({path:path.join(evidence,'mac-lobby.png')});
    const room=await page.evaluate(()=>window.auralink.hostRoom({name:'Mac bundle verification'}));
    const response=await health(room.url);assert.equal(response.pin,room.fingerprint);
    await page.evaluate(()=>window.auralink.stopRoom());
    await assert.rejects(health(room.url));
    assert.deepEqual(errors,[]);
    const results={passed:true,version:pkg.version,architecture:'arm64',dmg:path.basename(dmg),sha256:hash(fs.readFileSync(dmg)),
      checks:['DMG integrity and mounted application','arm64 app and unpacked input helper','bundle usage descriptions','deep strict code signature verification','signed app and audio helper microphone entitlements',
        'packaged source hashes match','safe native helper self-test','actual packaged Electron renderer launch','cold argument and warm open-url invitation delivery without navigation','pinned local HTTPS room starts and stops'],
      permissions:info.permissions,microphoneEntitlements,helperSelfTest:selfTest,sourceParity,signing:'ad-hoc testing build; no Developer ID or notarization',
      physicalDeviceTesting:'Not performed by this check. Microphone, screen capture, browser-to-LaunchServices room links and attended input require Mac owner permission and real-device testing.'};
    fs.writeFileSync(path.join(evidence,'mac-bundle-smoke.json'),JSON.stringify(results,null,2));
    console.log('Mac DMG verified: actual arm64 bundle, renderer, native helper, source and local TLS room. No hardware permission or remote input was requested.');
  } finally {
    if(application) await application.close();
    command('hdiutil',['detach',volume]);
    fs.rmSync(profile,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
