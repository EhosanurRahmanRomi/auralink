'use strict';

// Production APK runtime check on an isolated API 36 emulator. This never enables
// WebView debugging or targets a physical phone. Run after starting the named
// AuralinkAPI36 AVD; use --fixture-only for manually observed native UI testing.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const WebSocket=require('ws');
const selfsigned=require('selfsigned');
const {chromium}=require('playwright');
const {createBroker}=require('../src/core/broker.cjs');
const {fingerprint}=require('../src/core/invite.cjs');
const exec=promisify(execFile);
const project=path.resolve(__dirname,'..');
const sdk=process.env.ANDROID_SDK_ROOT || path.join(project,'.tools','android-sdk');
const adbPath=path.join(sdk,'platform-tools',process.platform==='win32'?'adb.exe':'adb');
const serial=process.env.AURALINK_EMULATOR_SERIAL || 'emulator-5556';
const pkg=require('../package.json');
const output=path.join(project,'test-results');
const fixtureDir=path.join(project,'.tools','android-runtime-fixture');
const apk=path.join(project,'release',`Auralink-${pkg.version}-Android.apk`);
const browserPath=[process.env.AURALINK_TEST_BROWSER,'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Google/Chrome/Application/chrome.exe','/usr/bin/chromium','/usr/bin/google-chrome'].filter(Boolean).find(file=>fs.existsSync(file));
const delay=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
let phase='setup';
let installedApkHash;
function safeError(error) {
  return String(error?.message || error).replace(/https?:\/\/[^\s'"<>]+(?:#|%23)key=[^\s'"<>]+/g,'[private test invitation redacted]')
    .replace(/((?:roomKey|hostToken|key)\s*[=:]\s*["']?)[A-Za-z0-9_-]{16,}/g,'$1[redacted]');
}
async function adb(args,options={}) {
  const result=await exec(adbPath,['-s',serial,...args],{encoding:'utf8',timeout:30000,maxBuffer:16*1024*1024,windowsHide:true,...options});
  return result.stdout;
}
function decodeXML(value) {return value.replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');}
async function hierarchy() {
  await adb(['shell','uiautomator','dump','--compressed','/sdcard/auralink-qa.xml'],{timeout:60000});
  const xml=await adb(['exec-out','cat','/sdcard/auralink-qa.xml']);
  return [...xml.matchAll(/<node\b([^>]*?)(?:\/>|>)/g)].map(match=>Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(pair=>[pair[1],decodeXML(pair[2])])));
}
function coordinates(node) {
  const match=node.bounds?.match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/);assert.ok(match,`Missing bounds for ${node.text || node['content-desc']}`);
  return [Math.round((+match[1]+ +match[3])/2),Math.round((+match[2]+ +match[4])/2)];
}
async function tap(node) {const [x,y]=coordinates(node);await adb(['shell','input','tap',String(x),String(y)]);}
async function findNode(predicate,timeout=30000) {
  const deadline=Date.now()+timeout;
  do {let nodes=[];try{nodes=await hierarchy();}catch{}const found=nodes.find(predicate);if(found)return found;await delay(800);}while(Date.now()<deadline);
  throw new Error(`Android UI element absent during ${phase}`);
}
async function invitationFields(timeout=30000) {
  const deadline=Date.now()+timeout;
  do {
    const fields=(await hierarchy()).filter(node=>node.class==='android.widget.EditText' && visible(node));
    if(fields.length===2)return fields;
    await delay(800);
  }while(Date.now()<deadline);
  throw new Error('The production invitation dialog did not expose both text inputs');
}
function safeHierarchy(nodes) {
  return nodes.map(node=>Object.fromEntries(['class','package','resource-id','bounds','clickable','enabled','focused','text','content-desc'].map(key=>[
    key,(key==='text' || key==='content-desc') && node.class==='android.widget.EditText' ? '[editable content omitted]' : safeError(node[key] || '')
  ])));
}
const label=(text)=>node=>node.text===text || node['content-desc']===text;
function visible(node) {
  const bounds=node.bounds?.match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/);
  return bounds && +bounds[3]>+bounds[1] && +bounds[4]>+bounds[2] && +bounds[2]<1147 && +bounds[4]>136;
}
async function screenshot(name) {fs.writeFileSync(path.join(output,name),await adb(['exec-out','screencap','-p'],{encoding:null}));}
async function type(value) {assert.ok(!value.includes("'"));await adb(['shell',`input text '${value.replaceAll(' ','%s')}'`]);}

async function nativeDevice() {
  assert.match(serial,/^emulator-\d+$/,'This test may target emulator serials only');
  const deadline=Date.now()+240000;
  while(Date.now()<deadline) {
    try {if((await adb(['shell','getprop','sys.boot_completed'])).trim()==='1')break;}catch{}
    await delay(2000);
  }
  assert.equal((await adb(['shell','getprop','sys.boot_completed'])).trim(),'1','Isolated emulator must finish booting');
  assert.equal((await adb(['shell','getprop','ro.boot.qemu.avd_name'])).trim(),'AuralinkAPI36','Refusing a different AVD');
  assert.equal((await adb(['shell','getprop','ro.build.version.sdk'])).trim(),'36');
  await adb(['shell','input','keyevent','82']);
  installedApkHash=crypto.createHash('sha256').update(fs.readFileSync(apk)).digest('hex');
  await adb(['install','--no-incremental','-r',apk],{timeout:120000});
  const installedPath=(await adb(['shell','pm','path','local.auralink.mobile'])).trim().replace(/^package:/,'');
  assert.match(installedPath,/^\/data\/app\/[A-Za-z0-9_~=/.-]+\/base\.apk$/);
  assert.equal((await adb(['shell',`sha256sum '${installedPath}'`])).split(/\s+/)[0],installedApkHash,'The installed APK must match the actual tested file');
  await adb(['shell','am','force-stop','local.auralink.mobile']);
  await adb(['shell','logcat','-c']);
  if(process.argv.includes('--control')) {
    // Enable the service only inside this verified throwaway emulator. Real
    // phones always require the owner to enable it in Android Settings.
    await adb(['shell','settings','put','secure','enabled_accessibility_services','local.auralink.mobile/local.auralink.mobile.AttendedAccessibilityService']);
    await adb(['shell','settings','put','secure','accessibility_enabled','1']);
  }
  await adb(['shell','am','start','-n','local.auralink.mobile/.MainActivity']);
}

async function hostFixture() {
  const cert=await selfsigned.generate([{name:'commonName',value:'Auralink isolated Android runtime QA'}],{keyType:'ec',curve:'P-256',algorithm:'sha256'});
  const broker=await createBroker({host:'0.0.0.0',name:'Android runtime verification',tls:{key:cert.private,cert:cert.cert},assetsDir:path.join(project,'src','renderer')});
  const ws=new WebSocket(`wss://127.0.0.1:${broker.port}/ws`,{rejectUnauthorized:false});
  const fixture={broker,ws,inbox:[],waiters:[],peerId:null,page:null,chain:Promise.resolve(),errors:[]};
  fixture.send=packet=>ws.send(JSON.stringify(packet));
  fixture.take=(type,timeout=30000)=>{
    const index=fixture.inbox.findIndex(packet=>packet.type===type);
    if(index>=0)return Promise.resolve(fixture.inbox.splice(index,1)[0]);
    return new Promise((resolve,reject)=>{const entry={type,resolve};entry.timer=setTimeout(()=>{fixture.waiters=fixture.waiters.filter(value=>value!==entry);reject(new Error(`No ${type} during ${phase}`));},timeout);fixture.waiters.push(entry);});
  };
  fixture.dispatch=operation=>{fixture.chain=fixture.chain.then(operation).catch(error=>fixture.errors.push(error.message));};
  ws.on('message',raw=>{
    const packet=JSON.parse(raw.toString());
    if(packet.type==='signal') {fixture.dispatch(()=>fixture.page.evaluate(packet=>rtc.receive(packet.from,packet.data),packet));return;}
    if(packet.type==='join-request') {
      fixture.peerId=packet.peerId;fixture.send({type:'approve',peerId:packet.peerId});
      fixture.dispatch(()=>fixture.page.evaluate(peer=>rtc.addPeer(peer),{id:packet.peerId,name:packet.name,role:'guest'}));
    }
    const index=fixture.waiters.findIndex(entry=>entry.type===packet.type);
    if(index>=0){const [entry]=fixture.waiters.splice(index,1);clearTimeout(entry.timer);entry.resolve(packet);}else fixture.inbox.push(packet);
  });
  await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
  fixture.send({type:'join',name:'Windows runtime QA receiver',roomKey:broker.roomKey,hostToken:broker.hostToken});
  fixture.id=(await fixture.take('welcome')).selfId;
  fixture.browser=await chromium.launch({executablePath:browserPath,headless:true,args:['--autoplay-policy=no-user-gesture-required','--disable-features=WebRtcHideLocalIpsWithMdns']});
  const context=await fixture.browser.newContext({ignoreHTTPSErrors:true});
  fixture.page=await context.newPage();
  await fixture.page.exposeFunction('fixtureSignal',(to,data)=>fixture.send({type:'signal',to,data}));
  await fixture.page.goto(`https://127.0.0.1:${broker.port}/health`);
  await fixture.page.evaluate(async id=>{
    const {RoomRTC}=await import('/rtc.js');
    document.body.textContent='Production Android projection receiver';
    window.rtc=new RoomRTC({selfId:id,signal:(to,data)=>window.fixtureSignal(to,data),iceServers:[]});
    window.runtimeErrors=[];window.runtimeTracks=[];
    rtc.addEventListener('error',event=>runtimeErrors.push(event.detail.error?.message));
    rtc.addEventListener('track',event=>{
      const {kind,track,stream,peerId}=event.detail;runtimeTracks.push({kind,peerId});
      let element=document.getElementById(`received-${kind}`);
      if(!element){element=document.createElement(kind==='audio'?'audio':'video');element.id=`received-${kind}`;element.autoplay=true;element.muted=kind!=='audio';element.playsInline=true;document.body.append(element);}
      element.srcObject=stream;element.play().catch(error=>runtimeErrors.push(error.message));
    });
  },fixture.id);
  fixture.invite=`https://10.0.2.2:${broker.port}/#key=${broker.roomKey}&fp=${fingerprint(cert.cert)}`;
  fs.mkdirSync(fixtureDir,{recursive:true});fs.writeFileSync(path.join(fixtureDir,'invitation.json'),JSON.stringify({invite:fixture.invite,port:broker.port},null,2));
  return fixture;
}

async function runUI(fixture) {
  phase='production APK lobby';console.log(phase);
  await findNode(node=>node.package==='local.auralink.mobile' && /Rooms|Your space|Settings/.test(node.text),60000);await screenshot('android-emulator-lobby.png');
  let join=(await hierarchy()).find(node=>label('Enter invitation')(node) && visible(node));
  for(let count=0;!join && count<3;count++) {
    await adb(['shell','input','swipe','355','1060','355','470','450']);await delay(1000);join=(await hierarchy()).find(node=>label('Enter invitation')(node) && visible(node));
  }
  assert.ok(join,'Scroll the production lobby to the invitation action');await tap(join);
  phase='production invitation dialog';
  const fields=await invitationFields();
  await screenshot('android-emulator-invitation-dialog.png');
  console.log('Production invitation dialog exposes both Android text inputs');
  await tap(fields[1]);await type(fixture.invite);await adb(['shell','input','keyevent','4']);
  console.log('Pinned invitation entered through the production Android text field');
  await tap(await findNode(label('Request to join')));
  await fixture.take('join-request',45000);
  await findNode(label('Turn microphone on'),45000);await screenshot('android-emulator-room.png');
  phase='Android owner screen permission';console.log(phase);
  await tap(await findNode(label('Share screen')));
  let permission=await findNode(node=>/Start now|Start recording|Start sharing/i.test(node.text) || node['resource-id']==='com.android.permissioncontroller:id/permission_allow_button',30000);
  if(permission['resource-id']==='com.android.permissioncontroller:id/permission_allow_button') {
    await tap(permission);permission=await findNode(node=>/Start now|Start recording|Start sharing/i.test(node.text),30000);
  }
  await screenshot('android-emulator-projection-permission.png');await tap(permission);
  phase='actual Android screen frames over WebRTC';console.log(phase);
  await fixture.page.waitForFunction(()=>{const video=document.getElementById('received-screen');return video && video.videoWidth>0 && video.currentTime>0 && video.readyState>=2;},undefined,{timeout:60000});
  const screen=await fixture.page.locator('#received-screen').evaluate(video=>({width:video.videoWidth,height:video.videoHeight,currentTime:video.currentTime,readyState:video.readyState}));
  await screenshot('android-emulator-sharing.png');
  const service=await adb(['shell','dumpsys','activity','services','local.auralink.mobile']);
  assert.match(service,/ScreenShareService/);assert.match(service,/isForeground=true/);
  let control=null;
  if(process.argv.includes('--control')) {
    phase='separate attended phone control approval';console.log(phase);
    await fixture.page.waitForFunction(id=>rtc.peers.get(id)?.channel?.readyState==='open',fixture.peerId,{timeout:30000});
    fixture.send({type:'control-request',to:fixture.peerId});
    await tap(await findNode(label('Allow control'),30000));
    await screenshot('android-emulator-native-control-consent.png');
    await tap(await findNode(node=>node['resource-id']==='android:id/button1' && node.text==='Allow control',30000));
    const grant=await fixture.take('control-response',30000);
    assert.equal(grant.from,fixture.peerId);assert.equal(grant.accepted,true);
    await findNode(node=>node['content-desc']==='Stop remote control immediately',30000);
    phase='actual Android Accessibility input';console.log(phase);
    await fixture.page.evaluate(({peerId,sessionId})=>{
      const send=event=>rtc.sendData(peerId,{type:'input',sessionId,event});
      send({type:'keydown',code:'Home',seq:1});send({type:'keyup',code:'Home',seq:2});
    },{peerId:fixture.peerId,sessionId:grant.sessionId});
    await findNode(node=>node.package==='com.google.android.apps.nexuslauncher',30000);
    await screenshot('android-emulator-remotely-opened-home.png');
    assert.match(await adb(['shell','dumpsys','media_projection']),/local\.auralink\.mobile/,'Attended control must keep the explicitly approved projection active');
    await adb(['shell','am','start','-n','local.auralink.mobile/.MainActivity']);
    await tap(await findNode(node=>node['content-desc']==='Stop remote control immediately',30000));
    await fixture.take('control-revoke',30000);
    await fixture.page.evaluate(({peerId,sessionId})=>{
      rtc.sendData(peerId,{type:'input',sessionId,event:{type:'keydown',code:'Home',seq:3}});
      rtc.sendData(peerId,{type:'input',sessionId,event:{type:'keyup',code:'Home',seq:4}});
    },{peerId:fixture.peerId,sessionId:grant.sessionId});
    await delay(1000);
    const resumed=(await adb(['shell','dumpsys','activity','activities'])).split('\n').find(line=>line.includes('topResumedActivity='));
    assert.match(resumed || '',/local\.auralink\.mobile/,'Revoked input must not reopen Home');
    control={passed:true,checks:['Separate in-app and native owner approval','Real encrypted RTC input received by Accessibility service','Remote Home action changes actual Android app','Foreground sharing remains during approved background control','Owner floating Stop control revokes broker grant','Stale session input rejected after stop']};
  }
  await tap(await findNode(node=>/Stop sharing|Stop screen sharing/.test(node['content-desc']) || node.text==='Stop sharing',20000));
  await delay(1500);
  const stopped=await adb(['shell','dumpsys','media_projection']);
  assert.ok(!stopped.includes('local.auralink.mobile'),'Stopping share must remove MediaProjection');
  const processId=(await adb(['shell','pidof','local.auralink.mobile'])).trim();
  assert.match(processId,/^\d+$/,'The actual Android app must remain alive after sharing');
  const fatal=(await adb(['shell','logcat','-d',`--pid=${processId}`,'-s','AndroidRuntime:E'])).trim();
  assert.ok(!fatal.includes('FATAL EXCEPTION'),fatal);
  assert.deepEqual(fixture.errors,[]);
  const sourceCheck=path.join(project,'.tools','runtime-source-check.json');
  return {passed:true,version:pkg.version,serial,api:36,apkSha256:installedApkHash,source:fs.existsSync(sourceCheck)?JSON.parse(fs.readFileSync(sourceCheck,'utf8')):null,screen,control,
    verified:['Production non-debuggable APK installed and loaded','Native pinned TLS room admission','Owner Android system projection consent','Actual MediaProjection screen frames decoded over WebRTC','Foreground sharing service','Owner share stop releases projection','No fatal Android runtime exception'],
    limitations:['Emulator has no physical microphone or speaker; physical audio route needs real-device test.',...(control?[]:['Phone Accessibility input requires a separate attended test.'])],errors:fixture.errors};
}

async function main() {
  assert.ok(fs.existsSync(adbPath));assert.ok(fs.existsSync(apk));assert.ok(browserPath);
  fs.mkdirSync(output,{recursive:true});let fixture;
  try {
    await nativeDevice();fixture=await hostFixture();
    if(process.argv.includes('--fixture-only')) {
      console.log(`Android runtime fixture ready on port ${fixture.broker.port}. Invitation is in ignored .tools/android-runtime-fixture/invitation.json.`);
      const interval=setInterval(async()=>{if(!fixture.peerId)return;try{const tracks=await fixture.page.evaluate(()=>runtimeTracks);if(tracks.length)console.log(JSON.stringify({tracks,decoded:await fixture.page.evaluate(()=>[...document.querySelectorAll('video')].map(video=>({kind:video.id,width:video.videoWidth,height:video.videoHeight,time:video.currentTime})))}));}catch{}},15000);
      await new Promise(resolve=>{process.once('SIGINT',resolve);process.once('SIGTERM',resolve);});clearInterval(interval);
    }else {const result=await runUI(fixture);fs.writeFileSync(path.join(output,'android-emulator.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));}
  }catch(error) {
    // Failure screenshots and raw UI dumps can contain an invitation field.
    // Keep those local/ignored; the workflow publishes only the safe summary.
    let diagnostics;
    try{await screenshot('android-emulator-failure.png');const nodes=await hierarchy();fs.writeFileSync(path.join(output,'android-emulator-failure-ui.json'),JSON.stringify(nodes,null,2));diagnostics=safeHierarchy(nodes);}catch{}
    fs.writeFileSync(path.join(output,'android-emulator.json'),JSON.stringify({passed:false,phase,error:safeError(error),ui:diagnostics},null,2));throw new Error(safeError(error));
  }finally {
    if(!process.argv.includes('--fixture-only')) await adb(['shell','am','force-stop','local.auralink.mobile']).catch(()=>{});
    if(fixture){
      for(const waiter of fixture.waiters)clearTimeout(waiter.timer);
      try{fixture.ws.close();}catch{}
      await fixture.browser?.close().catch(()=>{});
      await fixture.broker.stop().catch(()=>{});
    }
  }
}
main().catch(error=>{console.error(`Android emulator check failed during ${phase}: ${safeError(error)}`);process.exitCode=1;});
