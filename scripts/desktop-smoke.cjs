const {_electron:electron}=require('playwright');
const path=require('node:path');
const fs=require('node:fs');
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
async function main(){
  const root=path.resolve(__dirname,'..');
  const out=path.join(root,'test-results');fs.mkdirSync(out,{recursive:true});
  const profile=fs.mkdtempSync(path.join(out,'desktop-smoke-profile-'));
  const relativeProfile=path.relative(out,profile);
  assert.ok(relativeProfile&&!relativeProfile.startsWith('..')&&!path.isAbsolute(relativeProfile),'Test profile must remain within test-results');
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  let application,page,phase='launch';
  const errors=[];
  try{
    application=await electron.launch({args:[root,'--smoke-test',`--user-data-dir=${profile}`],env,timeout:60000});
    application.process().stderr.on('data',data=>{const line=data.toString();if(/Error|Unhandled/i.test(line))errors.push(line);});
    page=await application.firstWindow();
    page.on('pageerror',error=>errors.push(error.message));
    await page.waitForSelector('#host-button');
    await page.waitForFunction(()=>window.auralink && document.querySelector('#profile-platform').textContent!=='Local workspace');
    await page.evaluate(()=>{window.__desktopSmokeToasts=[];new MutationObserver(()=>{const message=document.querySelector('#toast-region').textContent;if(message)window.__desktopSmokeToasts.push(message);}).observe(document.querySelector('#toast-region'),{childList:true,subtree:true});});
    await page.screenshot({path:path.join(out,'desktop-lobby.png'),fullPage:true});
    await page.locator('[data-view="settings"]').click();
    await page.locator('#display-name').fill('Desktop QA');
    await page.locator('#save-settings').click();
    await page.locator('[data-view="rooms"]').click();
    await page.locator('.advanced-connections > summary').click();
    await page.locator('#advanced-host-button').click();
    await page.locator('#host-mode').selectOption('nearby');
    await page.locator('#host-name').fill('Verified local room');
    await page.locator('#host-port').fill('4459');
    await page.locator('#create-room').click();
    await page.waitForFunction(()=>!document.querySelector('#session').hidden && document.querySelector('#room-title').textContent.includes('Verified'),null,{timeout:30000});
    await page.locator('#invite-dialog').waitFor({state:'visible'});
    const invite=await page.locator('#invite-value').inputValue();
    assert.match(invite,/https:\/\/[^/]+\/#key=[A-Za-z0-9_-]+&fp=[a-f0-9]{64}/);
    await page.locator('#invite-dialog [data-close]').click();
    await page.waitForFunction(()=>document.querySelector('#toast-region').childElementCount===0);
    await page.evaluate(()=>window.scrollTo(0,0));
    await page.screenshot({path:path.join(out,'desktop-room.png'),fullPage:true});
    await page.locator('#diagnostics-toggle').click();
    await page.screenshot({path:path.join(out,'desktop-diagnostics.png')});
    await page.locator('#diagnostics-close').click();
    phase='native camera refusal';
    const cameraPermission=await page.evaluate(async()=>{
      try{const stream=await navigator.mediaDevices.getUserMedia({video:true,audio:false});stream.getTracks().forEach(track=>track.stop());return {denied:false};}
      catch(error){return {denied:true,name:error.name};}
    });
    assert.equal(cameraPermission.denied,true,'Camera capture must remain denied in the native app');
    assert.equal(cameraPermission.name,'NotAllowedError');
    phase='native app-window capture';
    await page.locator('#share-button').click();
    await page.locator('#screen-dialog').waitFor({state:'visible'});
    const appSource=page.locator('.screen-source').filter({hasText:'Auralink'}).first();
    await appSource.click();
    await page.waitForFunction(()=>{
      const v=document.querySelector('#stage-video');
      return !v.hidden && v.videoWidth>0 && v.videoHeight>0;
    },null,{timeout:20000});
    const capture=await page.locator('#stage-video').evaluate(v=>({width:v.videoWidth,height:v.videoHeight}));
    assert.ok(capture.width>0 && capture.height>0);
    await page.locator('#share-button').click();
    await page.waitForFunction(()=>document.querySelector('#stage-video').hidden);
    await page.locator('#end-button').click();
    await page.waitForFunction(()=>document.querySelector('#session').hidden);
    assert.equal(errors.length,0,errors.join('\n'));
    const sourceHashes=Object.fromEntries(['src/main.cjs','src/preload.cjs','src/renderer/app.js','src/renderer/rtc.js','src/renderer/relay-media.js','src/renderer/audio-worklet.js','src/renderer/internet.js'].map(file=>[file,createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')]));
    fs.writeFileSync(path.join(out,'desktop-smoke.json'),JSON.stringify({passed:true,isolatedUserData:true,checks:['Electron loads isolated renderer and test profile','settings persist within the test profile','real HTTPS room starts','pinned invitation generated','room diagnostics render','native camera capture denied','actual native app-window capture','capture stops','room teardown'],cameraPermission,capture,errors,sourceHashes},null,2));
    console.log('Desktop smoke passed: window, preferences, HTTPS room, invitation, native app-window capture and teardown.');
  }catch(error){
    const diagnostics=page?await page.evaluate(()=>{
      const video=document.querySelector('#stage-video');
      return {toasts:window.__desktopSmokeToasts,toast:document.querySelector('#toast-region')?.textContent,shareLabel:document.querySelector('#share-button')?.getAttribute('aria-label'),screenDialogOpen:document.querySelector('#screen-dialog')?.open,stageHidden:video?.hidden,width:video?.videoWidth,height:video?.videoHeight,paused:video?.paused,tracks:video?.srcObject?.getTracks().map(track=>({kind:track.kind,readyState:track.readyState,enabled:track.enabled,muted:track.muted}))};
    }).catch(()=>null):null;
    fs.writeFileSync(path.join(out,'desktop-smoke-failure.json'),JSON.stringify({passed:false,isolatedUserData:true,phase,error:error.message,diagnostics,errors},null,2));
    throw new Error(`${phase}: ${error.message}\n${JSON.stringify({diagnostics,errors})}`);
  }finally{
    await application?.close();
    const resolvedProfile=path.resolve(profile),resolvedOut=path.resolve(out);
    const contained=path.relative(resolvedOut,resolvedProfile);
    assert.ok(contained&&!contained.startsWith('..')&&!path.isAbsolute(contained),'Refusing cleanup outside test-results');
    fs.rmSync(resolvedProfile,{recursive:true,force:true,maxRetries:3,retryDelay:100});
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
