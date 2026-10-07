const {_electron:electron}=require('playwright');
const path=require('node:path');
const fs=require('node:fs');
const assert=require('node:assert/strict');
async function main(){
  const root=path.resolve(__dirname,'..');
  const out=path.join(root,'test-results');fs.mkdirSync(out,{recursive:true});
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const application=await electron.launch({args:[root,'--smoke-test'],env,timeout:60000});
  const errors=[];
  application.process().stderr.on('data',data=>{const line=data.toString();if(/Error|Unhandled/i.test(line))errors.push(line);});
  try{
    const page=await application.firstWindow();
    page.on('pageerror',error=>errors.push(error.message));
    await page.waitForSelector('#host-button');
    await page.waitForFunction(()=>window.auralink && document.querySelector('#profile-platform').textContent!=='Local workspace');
    await page.screenshot({path:path.join(out,'desktop-lobby.png')});
    await page.locator('[data-view="settings"]').click();
    await page.locator('#display-name').fill('Desktop QA');
    await page.locator('#save-settings').click();
    await page.locator('[data-view="rooms"]').click();
    await page.locator('#host-button').click();
    await page.locator('#host-name').fill('Verified local room');
    await page.locator('#host-port').fill('4459');
    await page.locator('#create-room').click();
    await page.waitForFunction(()=>!document.querySelector('#session').hidden && document.querySelector('#room-title').textContent.includes('Verified'),null,{timeout:30000});
    await page.locator('#invite-dialog').waitFor({state:'visible'});
    const invite=await page.locator('#invite-value').inputValue();
    assert.match(invite,/https:\/\/[^/]+\/#key=[A-Za-z0-9_-]+&fp=[a-f0-9]{64}/);
    await page.locator('#invite-dialog [data-close]').click();
    await page.screenshot({path:path.join(out,'desktop-room.png')});
    await page.locator('#diagnostics-toggle').click();
    await page.screenshot({path:path.join(out,'desktop-diagnostics.png')});
    await page.locator('#diagnostics-close').click();
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
    fs.writeFileSync(path.join(out,'desktop-smoke.json'),JSON.stringify({passed:true,checks:['Electron loads isolated renderer','settings persist','real HTTPS room starts','pinned invitation generated','room diagnostics render','actual native app-window capture','capture stops','room teardown'],capture,errors},null,2));
    console.log('Desktop smoke passed: window, preferences, HTTPS room, invitation, native app-window capture and teardown.');
  }finally{await application.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
