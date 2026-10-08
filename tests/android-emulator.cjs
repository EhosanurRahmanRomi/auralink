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
const {findRoomAction}=require('./android-room-action.cjs');
const {visibleInWebView}=require('./android-hierarchy.cjs');
const exec=promisify(execFile);
const project=path.resolve(__dirname,'..');
const sdk=process.env.ANDROID_SDK_ROOT || path.join(project,'.tools','android-sdk');
const adbPath=path.join(sdk,'platform-tools',process.platform==='win32'?'adb.exe':'adb');
const serial=process.env.AURALINK_EMULATOR_SERIAL || 'emulator-5556';
const pkg=require('../package.json');
const testedVersion=process.env.AURALINK_TEST_APK_VERSION || pkg.version;
const [testedMajor,testedMinor,testedPatch]=testedVersion.split('.').map(Number);
const freshSetupRegression=testedMajor>0 || testedMinor>3 || testedMinor===3 && testedPatch>=1;
const publicLifecycleRegression=testedMajor>0 || testedMinor>=4;
const output=path.join(project,'test-results');
const fixtureDir=path.join(project,'.tools','android-runtime-fixture');
const apk=process.env.AURALINK_TEST_APK ? path.resolve(process.env.AURALINK_TEST_APK) : path.join(project,'release',`Glance-Port-${pkg.version}-Android.apk`);
const receiverAssets=process.env.AURALINK_TEST_RENDERER_DIR ? path.resolve(process.env.AURALINK_TEST_RENDERER_DIR) : path.join(project,'src','renderer');
const browserPath=[process.env.AURALINK_TEST_BROWSER,'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Google/Chrome/Application/chrome.exe','/usr/bin/chromium','/usr/bin/google-chrome'].filter(Boolean).find(file=>fs.existsSync(file));
const delay=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
let phase='setup';
let installedApkHash;
let runtimeDiagnostics={};
let verifiedStages={};
function checkpoint(stage,evidence=true) {
  verifiedStages[stage]=evidence;
  fs.writeFileSync(path.join(output,'android-emulator.json'),JSON.stringify({passed:false,inProgress:true,phase,api:36,apkSha256:installedApkHash,verifiedStages,diagnostics:runtimeDiagnostics},null,2));
}
function safeError(error) {
  return String(error?.message || error).replace(/https?:\/\/[^\s'"<>]+(?:#|%23)key=[^\s'"<>]+/g,'[private test invitation redacted]')
    .replace(/A1\.[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}/gi,'[test room code redacted]')
    .replace(/((?:roomKey|hostToken|key)\s*[=:]\s*["']?)[A-Za-z0-9_-]{16,}/g,'$1[redacted]');
}
async function adb(args,options={}) {
  const result=await exec(adbPath,['-s',serial,...args],{encoding:'utf8',timeout:30000,maxBuffer:16*1024*1024,windowsHide:true,...options});
  return result.stdout;
}
function decodeXML(value) {return value.replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');}
async function hierarchy() {
  const result=await adb(['shell','am','instrument','-w','local.auralink.qa/.HierarchyInstrumentation'],{timeout:60000});
  assert.ok(!/INSTRUMENTATION_FAILED|FAILURES!!!|shortMsg=/.test(result),'The non-suppressing hierarchy observer must run successfully');
  assert.match(result,/qa_hierarchy=ok/,'The separate observer must report a fresh successful snapshot');
  assert.match(result,/accessibility_services_preserved=true/,'The observer must preserve Accessibility services');
  const xml=await adb(['exec-out','run-as','local.auralink.qa','cat','files/hierarchy.xml']);
  assert.match(xml,/observation-flags="dont-suppress-accessibility-services"/);
  return [...xml.matchAll(/<node\b([^>]*?)(?:\/>|>)/g)].map(match=>Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(pair=>[pair[1],decodeXML(pair[2])])));
}
function coordinates(node) {
  const match=node.bounds?.match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/);assert.ok(match,`Missing bounds for ${node.text || node['content-desc']}`);
  return [Math.round((+match[1]+ +match[3])/2),Math.round((+match[2]+ +match[4])/2)];
}
async function tap(node) {const [x,y]=coordinates(node);await adb(['shell','input','tap',String(x),String(y)]);}
async function findNode(predicate,timeout=30000) {
  let deadline=Date.now()+timeout;
  do {
    let nodes=[];try{nodes=await hierarchy();}catch{}
    const wait=nodes.find(node=>node['resource-id']==='android:id/aerr_wait');
    if(wait) {
      const recovered=Boolean(runtimeDiagnostics.anrs?.length);
      await recordANR(nodes);
      if(phase!=='production APK lobby' || recovered)throw new Error('Android reported an application ANR after the permitted cold-start recovery');
      await tap(wait);await delay(2000);deadline=Math.max(deadline,Date.now()+30000);continue;
    }
    const found=nodes.find(node=>predicate(node,nodes));if(found)return found;await delay(800);
  }while(Date.now()<deadline);
  throw new Error(`Android UI element absent during ${phase}`);
}
async function recordANR(nodes) {
  const title=nodes.find(node=>node['resource-id']==='android:id/alertTitle')?.text || 'Android application not responding';
  const state=await adb(['shell','dumpsys','activity','lastanr']).catch(()=> 'Last ANR state unavailable');
  const traces=await adb(['shell','dumpsys','activity','lastanr-traces'],{timeout:60000}).catch(()=> 'Last ANR traces unavailable');
  fs.writeFileSync(path.join(output,'android-emulator-anr-raw.txt'),state+'\n'+traces);
  const appSection=traces.match(/Cmd line: local\.auralink\.mobile[\s\S]*?(?=\n----- end|\n----- pid|$)/)?.[0] || '';
  const mainThread=appSection.match(/"main"[\s\S]*?(?=\n"|$)/)?.[0]?.slice(0,6000) || 'Main thread trace unavailable';
  const reason=state.split('\n').filter(line=>/ANR in |Reason:|Subject:|PID:|Process:/.test(line) && !/Intent|Bundle|extras/i.test(line)).slice(0,12).join('\n');
  const entry={phase,title:safeError(title),reason:safeError(reason),mainThread:safeError(mainThread)};
  runtimeDiagnostics.anrs=(runtimeDiagnostics.anrs || []).concat(entry);
  console.log(JSON.stringify({androidStartupANR:entry,recovery:'One owner Wait action; repeated ANRs fail the test'}));
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
async function focusInvitation(timeout=30000) {
  const deadline=Date.now()+timeout;
  let tabUsed=false;
  do {
    const nodes=await hierarchy();const node=nodes.find(value=>value['resource-id']==='join-invite' && visible(value));
    if(node?.focused==='true')return;
    if(!tabUsed && nodes.some(value=>value['resource-id']==='join-name' && value.focused==='true')) {
      await adb(['shell','input','keyevent','61']);tabUsed=true;await delay(500);continue;
    }
    if(node) {
      // HTML dialogs autofocus the name field and the IME then resizes the
      // native WebView. Use current bounds on each attempt, not the old form.
      const match=node.bounds.match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/);
      const x=Math.round((+match[1]+ +match[3])/2),y=Math.round(+match[2]+(+match[4]- +match[2])/4);
      await adb(['shell','input','tap',String(x),String(y)]);await delay(500);
    }
  }while(Date.now()<deadline);
  throw new Error('The invitation text area did not receive focus after current-bound taps');
}
async function tapStable(predicate,timeout=30000) {
  const deadline=Date.now()+timeout;let previous;
  do {
    const node=(await hierarchy()).find(value=>predicate(value) && visible(value));
    if(node && node.bounds===previous){await tap(node);return node;}
    previous=node?.bounds;await delay(300);
  }while(Date.now()<deadline);
  throw new Error(`Android action did not expose stable visible bounds during ${phase}`);
}
async function tapRoomAction(predicate,timeout=30000) {
  const node=await findNativeRoomAction(predicate,timeout);await tap(node);return node;
}
async function findNativeRoomAction(predicate,timeout=30000,observe) {
  try {
    return await findRoomAction(predicate,{read:hierarchy,swipe:(x1,y1,x2,y2)=>adb(['shell','input','swipe',...[x1,y1,x2,y2].map(String),'450']),wait:delay,timeout,observe});
  } catch(error) { throw new Error(`${error.message} during ${phase}`); }
}
async function keyboardShown() {
  const state=await adb(['shell','dumpsys','input_method']);
  const shown=state.match(/\bmInputShown=(true|false)\b/);
  assert.ok(shown,'Android input method visibility must be available before any Back action');
  return shown[1]==='true';
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
async function type(value) {
  assert.ok(!value.includes("'"));
  try {await adb(['shell',`input text '${value.replaceAll(' ','%s')}'`]);}
  catch {throw new Error('Android text injection command failed; private input omitted');}
}
function invitationInputDiagnostic(expected,actual) {
  let firstMismatchIndex=0;
  while(firstMismatchIndex<Math.min(expected.length,actual.length) && expected[firstMismatchIndex]===actual[firstMismatchIndex])firstMismatchIndex++;
  let originMatches=false,keyLength=0,fingerprintLength=0;
  try {
    const parsed=new URL(actual);originMatches=parsed.origin===new URL(expected).origin;
    const parameters=new URLSearchParams(parsed.hash.slice(1));keyLength=parameters.get('key')?.length || 0;fingerprintLength=parameters.get('fp')?.length || 0;
  }catch{}
  return {expectedLength:expected.length,enteredLength:actual.length,exactTextMatches:actual===expected,
    firstMismatchIndex:actual===expected?null:firstMismatchIndex,enteredIsExpectedPrefix:expected.startsWith(actual),originMatches,keyLength,fingerprintLength};
}
async function waitInvitationText(expected,timeout=5000) {
  const deadline=Date.now()+timeout;let actual='';
  do {
    const field=(await hierarchy()).find(node=>node['resource-id']==='join-invite');actual=field?.text || '';
    if(actual===expected)return {matched:true,actual};
    await delay(150);
  }while(Date.now()<deadline);
  return {matched:false,actual};
}
async function typeInvitation(value) {
  assert.ok(/^[\x21-\x7e]+$/.test(value),'The private test invitation must use printable ASCII');
  const attempts=[];
  for(const verifyEvery of [8,1]) {
    await focusInvitation();
    if(attempts.length) {
      // Real Android keyboard events only; never write the WebView DOM or
      // bypass the production invitation parser/native certificate check.
      await adb(['shell','input','keycombination','113','29']);
      await adb(['shell','input','keyevent','67']);
      assert.ok((await waitInvitationText('')).matched,'Android invitation field must clear before retrying text input');
    }
    let result={matched:false,actual:''};let submittedLength=0;
    for(let offset=0;offset<value.length;offset++) {
      // Android's shell input text emits a whole string too quickly for this
      // cold WebView. Pace real key events and verify bounded prefixes.
      await type(value[offset]);submittedLength++;
      await delay(100);
      if(submittedLength%verifyEvery && submittedLength!==value.length)continue;
      result=await waitInvitationText(value.slice(0,submittedLength));
      if(!result.matched)break;
    }
    const diagnostic={charactersPerInput:1,verifyEvery,submittedLength,...invitationInputDiagnostic(value,result.actual)};attempts.push(diagnostic);
    runtimeDiagnostics.invitation={...diagnostic,inputAttempts:attempts};
    if(result.matched && submittedLength===value.length)return;
  }
  throw new Error('Android text input must preserve the complete invitation exactly after paced input and one cleared retry');
}
async function audioMode(expected,timeout=15000) {
  const deadline=Date.now()+timeout;
  do {
    const dump=await adb(['shell','dumpsys','audio']);
    const actual=dump.match(/Actual mode\s*=\s*(MODE_[A-Z_]+)/)?.[1];
    if(actual===expected)return actual;
    await delay(500);
  }while(Date.now()<deadline);
  throw new Error(`Android audio mode did not become ${expected}`);
}
async function rtcEvidence(page,predicate,arg,timeout=45000) {
  // Await asynchronous browser statistics explicitly. waitForFunction's DOM
  // polling can treat a returned Promise as truthy before its result resolves.
  const deadline=Date.now()+timeout;
  do {
    const evidence=await page.evaluate(predicate,arg);
    if(evidence)return evidence;
    await delay(250);
  }while(Date.now()<deadline);
  throw new Error(`Verified RTC evidence did not arrive during ${phase}`);
}
async function startPhoneAudio(fixture) {
  phase='actual Android microphone permission and RTP';console.log(phase);
  await tapRoomAction(label('Turn microphone on'));
  const permission=await findNode(node=>label('Turn microphone off')(node) || node['resource-id']==='com.android.permissioncontroller:id/permission_allow_foreground_only_button' || node['resource-id']==='com.android.permissioncontroller:id/permission_allow_button');
  if (!label('Turn microphone off')(permission)) { await screenshot('android-emulator-microphone-permission.png');await tap(permission); }
  await findNativeRoomAction(label('Turn microphone off'),30000);
  await rtcEvidence(fixture.page,async id=>{
    const entry=rtc.peers.get(id);const stats=(await rtc.stats()).find(row=>row.peerId===id);
    return entry?.remoteTracks.get('audio')?.track.readyState==='live' && stats?.receivedAudioPackets>0;
  },fixture.peerId);
  const first=await fixture.page.evaluate(async id=>(await rtc.stats()).find(row=>row.peerId===id).receivedAudioPackets,fixture.peerId);
  await rtcEvidence(fixture.page,async ({id,first})=>(await rtc.stats()).find(row=>row.peerId===id)?.receivedAudioPackets>first,{id:fixture.peerId,first},15000);
  const incoming=await fixture.page.evaluate(async id=>{
    const row=(await rtc.stats()).find(row=>row.peerId===id);
    return {packetsReceived:row.receivedAudioPackets,codec:row.audioCodec,trackState:rtc.peers.get(id).remoteTracks.get('audio').track.readyState};
  },fixture.peerId);
  assert.ok(incoming.packetsReceived>first && incoming.trackState==='live','Android microphone RTP must actually increase');
  checkpoint('phoneMicrophoneRtpReceived',incoming);
  assert.equal(await audioMode('MODE_IN_COMMUNICATION'),'MODE_IN_COMMUNICATION');
  checkpoint('androidCommunicationAudioMode');
  await fixture.page.evaluate(async ()=>{
    window.runtimeToneContext=new AudioContext({sampleRate:48000});
    const destination=runtimeToneContext.createMediaStreamDestination();
    window.runtimeTone=runtimeToneContext.createOscillator();const gain=runtimeToneContext.createGain();
    runtimeTone.frequency.value=880;gain.gain.value=0.025;runtimeTone.connect(gain).connect(destination);runtimeTone.start();
    await runtimeToneContext.resume();await rtc.setTrack('audio',destination.stream.getAudioTracks()[0],destination.stream);
  });
  const outgoing=await rtcEvidence(fixture.page,async id=>{
    const entry=rtc.peers.get(id);if(!entry)return false;
    const rows=[...(await entry.pc.getStats()).values()];
    const sent=rows.find(row=>row.type==='outbound-rtp' && row.kind==='audio' && row.packetsSent>0);
    const acknowledged=rows.find(row=>row.type==='remote-inbound-rtp' && row.kind==='audio' && row.roundTripTimeMeasurements>0);
    return sent && acknowledged ? {packetsSent:sent.packetsSent,roundTripTimeMeasurements:acknowledged.roundTripTimeMeasurements,roundTripTime:acknowledged.roundTripTime} : false;
  },fixture.peerId);
  // Keep the same successful stats snapshot. A later report can omit a
  // transient remote-inbound row while transceivers finish renegotiation.
  assert.ok(outgoing.packetsSent>0 && outgoing.roundTripTimeMeasurements>0,'Android must actually acknowledge outgoing host audio');
  checkpoint('syntheticHostAudioAcknowledgedByAndroid',outgoing);
  await screenshot('android-emulator-audio-active.png');
  return {passed:true,phoneToHost:incoming,syntheticHostToPhone:outgoing,mode:'MODE_IN_COMMUNICATION',checks:['Native Android microphone permission approved by the test owner','Live WebView microphone track sends increasing encrypted RTP packets','Synthetic host tone RTP acknowledged by actual Android receiver','Actual Android communication audio mode'],physicalMicrophoneAndSpeakerVerified:false};
}
async function callTransportStats(fixture) {
  return fixture.page.evaluate(async id=>{
    const entry=rtc.peers.get(id);if(!entry)return null;
    const rows=[...(await entry.pc.getStats()).values()];
    return {received:rows.find(row=>row.type==='inbound-rtp' && row.kind==='audio')?.packetsReceived || 0,
      acknowledged:rows.find(row=>row.type==='remote-inbound-rtp' && row.kind==='audio')?.roundTripTimeMeasurements || 0,
      connection:entry.pc.connectionState};
  },fixture.peerId);
}
async function callServiceTypes(required,timeout=15000) {
  const deadline=Date.now()+timeout;
  do {
    const service=await adb(['shell','dumpsys','activity','services','local.auralink.mobile']);
    const section=service.split(/\n\s*\* ServiceRecord/).find(value=>value.includes('CallSessionService'));
    const match=section?.match(/isForeground=true[^\n]*\btypes=(?:0x)?([a-f0-9]+)/i);
    const types=match ? parseInt(match[1],16) : 0;
    if((types&required)===required)return types;
    await delay(300);
  }while(Date.now()<deadline);
  throw new Error('The explicit native room/call foreground service did not become active');
}
async function checkCallHomeReturn(fixture,audio) {
  phase='nonsharing Android call survives Home and return';console.log(phase);
  const processBefore=(await adb(['shell','pidof','local.auralink.mobile'])).trim();assert.match(processBefore,/^\d+$/);
  const activityIdentity=async()=>{
    const state=await adb(['shell','dumpsys','activity','activities']);
    return state.match(/ActivityRecord\{([a-f0-9]+) u\d+ local\.auralink\.mobile\/\.MainActivity t(\d+)/)?.[0];
  };
  const activityBefore=await activityIdentity();assert.ok(activityBefore);
  const joins=fixture.network.incomingTypes.join || 0, closes=fixture.network.socketCloses.length;
  await callServiceTypes(0x10|0x80);
  assert.ok(!(await adb(['shell','dumpsys','media_projection'])).includes('local.auralink.mobile'),'This regression must run without screen projection');
  await adb(['shell','input','keyevent','3']);
  const homeComponent=(await adb(['shell','cmd','package','resolve-activity','--brief','-a','android.intent.action.MAIN','-c','android.intent.category.HOME'])).trim().split(/\r?\n/).find(line=>/^[\w.]+\//.test(line));
  assert.ok(homeComponent);const homePackage=homeComponent.split('/')[0];
  await findNode(node=>node.package===homePackage);
  const first=await callTransportStats(fixture);assert.ok(first?.received>0 && first.acknowledged>0);
  await rtcEvidence(fixture.page,async ({id,first})=>{
    const entry=rtc.peers.get(id);if(!entry)return false;
    const rows=[...(await entry.pc.getStats()).values()];
    const received=rows.find(row=>row.type==='inbound-rtp' && row.kind==='audio')?.packetsReceived || 0;
    const acknowledged=rows.find(row=>row.type==='remote-inbound-rtp' && row.kind==='audio')?.roundTripTimeMeasurements || 0;
    return received>first.received && acknowledged>first.acknowledged && entry.pc.connectionState==='connected' ? {received,acknowledged} : false;
  },{id:fixture.peerId,first},30000);
  const top=(await adb(['shell','dumpsys','activity','activities'])).split('\n').find(line=>line.includes('topResumedActivity='));
  assert.ok(top?.includes(homePackage),'Home must remain foreground while both-direction audio evidence advances');
  await adb(['shell','am','start','-n','local.auralink.mobile/.MainActivity']);
  await findNativeRoomAction(label('Turn microphone off'));
  assert.equal((await adb(['shell','pidof','local.auralink.mobile'])).trim(),processBefore,'Returning must not restart the native process');
  assert.equal(await activityIdentity(),activityBefore,'Returning must reuse the existing Activity');
  assert.equal(fixture.network.incomingTypes.join || 0,joins,'Returning must not rejoin the room');
  assert.equal(fixture.network.socketCloses.length,closes,'Backgrounding an ongoing call must not close authenticated signaling');
  assert.equal(await audioMode('MODE_IN_COMMUNICATION'),'MODE_IN_COMMUNICATION');
  checkpoint('nonSharingCallHomeReturn',{passed:true,callForegroundService:true,microphoneType:true,homeRemainedForeground:true,
    increasingPhoneRtp:true,newAndroidAudioAcknowledgment:true,sameProcess:true,sameActivity:true,noRoomRejoin:true,noSignalingClose:true,microphoneStillEnabledOnReturn:true});
  audio.checks.push('Nonsharing Home→return retains process, Activity, room, microphone and increasing bidirectional RTP');
}
async function checkProjectionRotation(fixture) {
  phase='native projection follows real Android orientation';console.log(phase);
  const joins=fixture.network.incomingTypes.join || 0;
  await adb(['shell','settings','put','system','accelerometer_rotation','0']);
  try {
    await adb(['shell','settings','put','system','user_rotation','1']);
    await fixture.page.waitForFunction(()=>{const video=document.getElementById('received-screen');return video?.videoWidth>video?.videoHeight && video.currentTime>0 && video.readyState>=2;},undefined,{timeout:30000});
    const landscape=await fixture.page.locator('#received-screen').evaluate(video=>({width:video.videoWidth,height:video.videoHeight}));
    await adb(['shell','settings','put','system','user_rotation','0']);
    await fixture.page.waitForFunction(()=>{const video=document.getElementById('received-screen');return video?.videoHeight>video?.videoWidth && video.currentTime>0 && video.readyState>=2;},undefined,{timeout:30000});
    const portrait=await fixture.page.locator('#received-screen').evaluate(video=>({width:video.videoWidth,height:video.videoHeight}));
    assert.equal(fixture.network.incomingTypes.join || 0,joins,'Rotation must not restart room admission');
    assert.match(await adb(['shell','dumpsys','media_projection']),/local\.auralink\.mobile/,'Rotation keeps the approved projection active');
    checkpoint('projectionOrientationRoundTrip',{passed:true,landscape,portrait,admissionUnchanged:true});
  } finally { await adb(['shell','settings','put','system','user_rotation','0']); }
}

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
  // sys.boot_completed precedes first-boot package optimization and WebView
  // provider startup on this cold CI image. Let Android finish that work.
  await delay(30000);
  await adb(['shell','input','keyevent','82']);
  installedApkHash=crypto.createHash('sha256').update(fs.readFileSync(apk)).digest('hex');
  await adb(['install','--no-incremental','-r',apk],{timeout:120000});
  const installedPath=(await adb(['shell','pm','path','local.auralink.mobile'])).trim().replace(/^package:/,'');
  assert.match(installedPath,/^\/data\/app\/[A-Za-z0-9_~=/.-]+\/base\.apk$/);
  assert.equal((await adb(['shell',`sha256sum '${installedPath}'`])).split(/\s+/)[0],installedApkHash,'The installed APK must match the actual tested file');
  checkpoint('productionApkInstalled');
  if (freshSetupRegression) {
    // The verified, throwaway AVD must exercise a truly unpaired installation.
    // This never targets a physical device or changes a user's saved setup.
    assert.match(await adb(['shell','pm','clear','local.auralink.mobile']),/Success/);
    checkpoint('isolatedAppDataResetForFreshSetup');
  }
  const observerApk=path.join(project,'.tools','qa-hierarchy','Auralink-QA-hierarchy.apk');
  assert.ok(fs.existsSync(observerApk),'Build the separate non-suppressing QA observer before native runtime testing');
  await adb(['install','--no-incremental','-r',observerApk],{timeout:120000});
  checkpoint('separateNonSuppressingObserverInstalled');
  await adb(['shell','am','force-stop','local.auralink.mobile']);
  await adb(['shell','logcat','-c']);
  await adb(['shell','am','start','-n','local.auralink.mobile/.MainActivity']);
}

async function accessibilityBound(timeout=30000) {
  const deadline=Date.now()+timeout;
  do {
    const dump=await adb(['shell','dumpsys','accessibility']);
    const bound=dump.match(/Bound services:\{([\s\S]*?)\n\s*Enabled services:/i)?.[1];
    if(bound?.includes('label=Glance-Port attended control'))return true;
    await delay(500);
  }while(Date.now()<deadline);
  const dump=await adb(['shell','dumpsys','accessibility']);
  runtimeDiagnostics.accessibility={boundAuralinkService:/Bound services:\{[\s\S]*?label=Glance-Port attended control[^\n]*\n\s*Enabled services:/i.test(dump),
    enabledSetting:(await adb(['shell','settings','get','secure','enabled_accessibility_services'])).trim().includes('local.auralink.mobile'),
    safeSystemState:dump.split('\n').filter(line=>/Bound services:|Enabled services:|Binding services:|Crashed services:|UiAutomation|suppress/i.test(line)).map(line=>safeError(line)).join('\n').slice(0,3000)};
  throw new Error('Android must actually bind the isolated emulator Accessibility service before testing attended control');
}

async function hostFixture() {
  const cert=await selfsigned.generate([{name:'commonName',value:'Auralink isolated Android runtime QA'}],{keyType:'ec',curve:'P-256',algorithm:'sha256'});
  const broker=await createBroker({host:'0.0.0.0',name:'Android runtime verification',tls:{key:cert.private,cert:cert.cert},assetsDir:receiverAssets});
  const ws=new WebSocket(`wss://127.0.0.1:${broker.port}/ws`,{rejectUnauthorized:false});
  const fixture={broker,ws,inbox:[],waiters:[],peerId:null,page:null,chain:Promise.resolve(),errors:[],network:{healthRequests:0,socketUpgrades:0,tlsErrorCodes:[],incomingTypes:{},outgoingTypes:{},socketCloses:[]}};
  // Observe the unmodified broker's incoming frame only for a static native
  // rejection reason. The broker intentionally omits reasons on its response.
  // Never retain peer/session identifiers, room credentials or arbitrary text.
  const originalEmit=WebSocket.prototype.emit;
  const safeReasons=new Set(['Share the full phone display before granting control.','Approval expired or the room changed.','Android input permission is unavailable.','Desktop control could not start.']);
  WebSocket.prototype.emit=function(event,...args) {
    if(this._isServer && event==='message') {
      try {
        const packet=JSON.parse(args[0].toString());
        if(typeof packet.type==='string' && /^[a-z-]{1,32}$/.test(packet.type)) fixture.network.incomingTypes[packet.type]=(fixture.network.incomingTypes[packet.type] || 0)+1;
        if(packet.type==='control-response') runtimeDiagnostics.nativeControlResponse={accepted:packet.accepted===true,
          reason:packet.accepted===true?null:safeReasons.has(packet.reason)?packet.reason:'Rejection reason omitted'};
      }catch{}
    }
    if(this._isServer && event==='close') fixture.network.socketCloses.push({code:args[0],reason:safeError(String(args[1] || '')).slice(0,160)});
    return Reflect.apply(originalEmit,this,[event,...args]);
  };
  const originalSend=WebSocket.prototype.send;
  WebSocket.prototype.send=function(data,...args) {
    if(this._isServer) {
      try { const packet=JSON.parse(String(data));
        if(typeof packet.type==='string' && /^[a-z-]{1,32}$/.test(packet.type)) fixture.network.outgoingTypes[packet.type]=(fixture.network.outgoingTypes[packet.type] || 0)+1;
      } catch {}
    }
    return Reflect.apply(originalSend,this,[data,...args]);
  };
  fixture.restoreObserver=()=>{WebSocket.prototype.emit=originalEmit;WebSocket.prototype.send=originalSend;};
  broker.server.on('request',request=>{if(request.url==='/health')fixture.network.healthRequests++;});
  broker.server.on('upgrade',request=>{if(request.url==='/ws')fixture.network.socketUpgrades++;});
  broker.server.on('tlsClientError',error=>fixture.network.tlsErrorCodes.push(error.code || 'TLS handshake rejected'));
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

async function checkFreshInternetSetup(fixture) {
  phase='fresh Android Internet setup guidance';console.log(phase);
  const before={healthRequests:fixture.network.healthRequests,socketUpgrades:fixture.network.socketUpgrades,joins:fixture.network.incomingTypes.join || 0};
  // Android WebView may expose the HTML title as the button's accessible name.
  // The stable view ID identifies the real action independently of that name.
  const create=await findNativeRoomAction(node=>node['resource-id']==='host-button',30000,(nodes,node)=>{
    if(!runtimeDiagnostics.freshSetupInitialActions)runtimeDiagnostics.freshSetupInitialActions=safeHierarchy(nodes.filter(value=>['host-button','join-button'].includes(value['resource-id'])));
  });
  assert.equal(create.enabled,'true','Fresh Create a room must be enabled');await tap(create);
  let service;
  try { service=await findNode(node=>node['resource-id']==='internet-service' && node.class==='android.widget.EditText' && node.focused==='true',30000); }
  catch { throw new Error('Native setup visibility check failed: focused service input was not exposed after Create a room. Inspect the local hierarchy and screenshot.'); }
  // Android Accessibility can expose the input placeholder as node.text. The
  // browser regression separately proves the actual HTML value remains empty.
  assert.ok(!service.text || service.text==='https://your-space.workers.dev','Fresh native setup must show an empty service field or its example placeholder');
  if(await keyboardShown()) await adb(['shell','input','keyevent','4']);
  let hint;
  try { hint=await findNode(node=>node['resource-id']==='internet-setup-hint' && /Enter the private service address and pairing code supplied by your group owner/.test(node.text || ''),30000); }
  catch { throw new Error('Native setup visibility check failed: persistent setup instructions were not exposed after dismissing the keyboard. Inspect the local hierarchy and screenshot.'); }
  assert.match(hint.text,/Go online/);assert.match(hint.text,/create your room again/i);
  let nodes=await hierarchy();
  assert.ok(!nodes.some(node=>label('Create your room')(node) || label('Create room')(node)), 'The host modal must close so Settings can be used immediately');
  assert.ok(!nodes.some(node=>label('Turn microphone on')(node) || label('Leave room')(node)), 'Missing Internet setup cannot enter an admitted room');
  assert.ok(!nodes.some(node=>/invalid (?:internet service|url)|Invalid URL/i.test(node.text || '')), 'Fresh setup must explain the required fields rather than show a generic URL error');
  // The keyboard can resize the native WebView. Observe each real setting
  // after it closes rather than tapping cached document coordinates.
  await findNode(label('Private service address'));
  await findNode(label('Private pairing code'));
  await findNode(label('Go online'));
  await screenshot('android-emulator-fresh-internet-setup.png');
  const networkAfter={healthRequests:fixture.network.healthRequests,socketUpgrades:fixture.network.socketUpgrades,joins:fixture.network.incomingTypes.join || 0};
  assert.deepEqual(networkAfter,before,'Missing setup must not attempt native signaling or room admission');
  await tapStable(node=>label('Rooms')(node) && node.class==='android.widget.Button');
  for (const id of ['host-button','join-button']) {
    const action=await findNativeRoomAction(node=>node['resource-id']===id);
    assert.equal(action.enabled,'true','Setup guidance must leave both room actions usable after returning to Rooms');
  }
  checkpoint('freshInternetSetupGuidance',{passed:true,ownerAction:'Create a room',serviceInputFocused:true,actionableServiceAndPairingFields:true,persistentSetupHint:true,hostModalClosed:true,noAdmissionAttempt:true,roomActionsRemainUsable:true});
}

async function checkPublicRoomStart(fixture) {
  phase='fresh Android public room start';console.log(phase);
  const before={healthRequests:fixture.network.healthRequests,socketUpgrades:fixture.network.socketUpgrades,joins:fixture.network.incomingTypes.join || 0};
  const create=await findNativeRoomAction(node=>node['resource-id']==='host-button');
  assert.equal(create.enabled,'true');await tap(create);
  const code=await findNode(node=>node['resource-id']==='room-code' && /A1\.[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}/i.test(node.text || node['content-desc'] || ''),60000);
  assert.ok(code,'Fresh Android must open a public room and expose a share code without a service/pairing form');
  await findNativeRoomAction(label('Turn microphone on'));
  assert.ok(!(await hierarchy()).some(node=>node['resource-id']==='camera-button'), 'Screen and audio room has no camera control');
  const projection=await adb(['shell','dumpsys','media_projection']);
  assert.ok(!projection.includes('local.auralink.mobile'),'Starting a public room must not silently capture the screen');
  const types=await callServiceTypes(0x10);
  assert.equal(types&0xc2,0,'An open room without media may use connectedDevice, but cannot declare active microphone, camera or playback');
  assert.deepEqual({healthRequests:fixture.network.healthRequests,socketUpgrades:fixture.network.socketUpgrades,joins:fixture.network.incomingTypes.join || 0},before,'Public setup must not use the separate Nearby fixture');
  checkpoint('freshPublicRoomOpened',{passed:true,systemPkiCoordinator:true,shareCodeShapeVerified:true,microphoneOff:true,noCameraControl:true,screenProjectionAbsent:true,connectedDeviceRoomService:true,noMicrophoneCameraOrPlaybackType:true});
  const beforeCode=code.text || code['content-desc'];
  const processBefore=(await adb(['shell','pidof','local.auralink.mobile'])).trim();
  await adb(['shell','input','keyevent','3']);await delay(5000);
  await callServiceTypes(0x10);
  await adb(['shell','am','start','-n','local.auralink.mobile/.MainActivity']);
  const retained=await findNativeRoomAction(node=>node['resource-id']==='room-code' && (node.text || node['content-desc'])===beforeCode);
  assert.ok(retained,'Returning to an open room must retain the exact room capability rather than opening a replacement');
  assert.equal((await adb(['shell','pidof','local.auralink.mobile'])).trim(),processBefore);
  await findNativeRoomAction(label('Turn microphone on'));
  assert.ok(!(await hierarchy()).some(node=>node['resource-id']==='camera-button'));
  checkpoint('openPublicRoomHomeReturn',{passed:true,existingRoomCodeRetained:true,sameProcess:true,roomServiceRemainsActive:true,microphoneRemainsOff:true,noCameraControl:true});
  const pendingCode='A1.00000000-0000-4000-8000-000000000004.'+'A'.repeat(43);
  await adb(['shell','am','start','-a','android.intent.action.VIEW','-d','auralink://join#code='+pendingCode,'-n','local.auralink.mobile/.MainActivity']);
  await findNativeRoomAction(node=>node['resource-id']==='dismiss-incoming-invite');
  await findNode(node=>/A new invitation is ready\. Leave your current room/.test(node.text || ''));
  await findNativeRoomAction(node=>node['resource-id']==='room-code' && (node.text || node['content-desc'])===beforeCode);
  assert.equal((await adb(['shell','pidof','local.auralink.mobile'])).trim(),processBefore,'App invitation must reuse the current process');
  await tapRoomAction(node=>node['resource-id']==='dismiss-incoming-invite');
  checkpoint('nativeAppInvitationWhileRoomOpen',{passed:true,actualAndroidViewIntent:true,currentRoomRetained:true,sameProcess:true,newInvitationRequiresLeavingCurrentRoom:true,noCaptureOrControlGranted:true});
  if (testedMajor>0 || testedMinor>4 || testedMinor===4 && testedPatch>=1) await checkNativePublicRelayMedia(fixture,beforeCode);
  phase='owner leaves tested public room before Nearby regression';console.log(phase);
  await tapRoomAction(label('Leave room'));
  await findNativeRoomAction(node=>node['resource-id']==='join-button' && node.enabled==='true');
  checkpoint('freshPublicRoomLeftBeforeNearbyRegression');
}

async function checkNativePublicRelayMedia(fixture,codeText) {
  const publicPhase=detail=>{phase='Android public relay: '+detail;console.log(phase);};
  publicPhase('open hostname-verified public socket');
  const code=/A1\.([a-f0-9-]{36})\.([A-Za-z0-9_-]{43})/i.exec(codeText);
  assert.ok(code,'Native public room must expose a complete invitation capability');
  const originMatch=fs.readFileSync(path.join(receiverAssets,'internet.js'),'utf8').match(/DEFAULT_PUBLIC_ORIGIN\s*=\s*'([^']+)'/);
  assert.ok(originMatch);const origin=new URL(originMatch[1]);assert.equal(origin.protocol,'https:');
  const publicURL=new URL('/internet/ws',origin);publicURL.protocol='wss:';
  // The remote socket uses Node's normal CA/hostname validation. Only the
  // localhost page serving the actual renderer modules is a self-signed fixture.
  const socket=new WebSocket(publicURL.href,{rejectUnauthorized:true,maxPayload:262144});
  let page,peerId,heartbeat,recordPublicProgress,chain=Promise.resolve(),active=false;
  const inbox=[],waiters=[],errors=[],wire={sent:0,received:0,encryptedEnvelopesOnly:true};
  const send=packet=>{
    if(socket.readyState!==WebSocket.OPEN)return false;
    if(packet.type==='signal' && packet.data?.relay) {
      wire.sent++;const envelope=packet.data.relay;
      wire.encryptedEnvelopesOnly &&= Object.keys(packet.data).join(',')==='relay' && Object.keys(envelope).sort().join(',')==='ciphertext,counter,epoch,nonce,version';
    }
    socket.send(JSON.stringify(packet));return true;
  };
  const take=(type,timeout=30000)=>{
    const index=inbox.findIndex(packet=>packet.type===type);if(index>=0)return Promise.resolve(inbox.splice(index,1)[0]);
    return new Promise((resolve,reject)=>{const pending={type,resolve};pending.timer=setTimeout(()=>{const index=waiters.indexOf(pending);if(index>=0)waiters.splice(index,1);reject(new Error('The public relay fixture did not complete '+type));},timeout);waiters.push(pending);});
  };
  socket.on('message',raw=>{
    const packet=JSON.parse(raw.toString());
    if(packet.type==='signal' && packet.data?.relay) {wire.received++;wire.encryptedEnvelopesOnly &&= Object.keys(packet.data).join(',')==='relay';}
    if(packet.type==='signal' && active) {chain=chain.then(()=>page.evaluate(packet=>publicRTC.receive(packet.from,packet.data),packet)).catch(error=>errors.push(safeError(error)));return;}
    const index=waiters.findIndex(pending=>pending.type===packet.type);
    if(index>=0){const [pending]=waiters.splice(index,1);clearTimeout(pending.timer);pending.resolve(packet);}else inbox.push(packet);
  });
  socket.on('error',error=>errors.push(safeError(error)));
  try {
    await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
    publicPhase('register fixture receiver');
    send({type:'bootstrap',name:'Android public relay receiver'});await take('registered');
    heartbeat=setInterval(()=>send({type:'ping'}),15000);
    publicPhase('join the actual native public room');
    send({type:'join',roomId:code[1],roomKey:code[2]});const welcome=await take('welcome');
    assert.equal(welcome.websocketRelayEnabled,true);assert.match(welcome.relayKey,/^[A-Za-z0-9_-]{43}$/);
    assert.equal(welcome.peers.length,1,'The isolated public room contains exactly the production APK owner');peerId=welcome.peers[0].id;
    publicPhase('force receiver onto encrypted relay and start synthetic reverse audio');
    page=await fixture.browser.newPage({ignoreHTTPSErrors:true});
    await page.exposeFunction('publicSignal',(to,data)=>send({type:'signal',to,data}));
    await page.goto(`https://127.0.0.1:${fixture.broker.port}/health`);
    await page.evaluate(async welcome=>{
      const {RoomRTC}=await import('/rtc.js');window.publicPCs=[];window.publicErrors=[];
      const RealRTC=window.RTCPeerConnection;
      window.RTCPeerConnection=new Proxy(RealRTC,{construct(target,args){const pc=Reflect.construct(target,[{...args[0],iceServers:[],iceTransportPolicy:'relay'}]);publicPCs.push(pc);return pc;}});
      document.body.textContent='Native Android public relay receiver';
      window.publicRTC=new RoomRTC({selfId:welcome.selfId,signal:(to,data)=>window.publicSignal(to,data),iceServers:[],iceTransportPolicy:'relay',
        websocketRelayEnabled:true,relayKey:welcome.relayKey,relayLimits:welcome.websocketRelayLimits});
      publicRTC.setVideoLimits('720');publicRTC.addEventListener('error',event=>publicErrors.push(event.detail.error?.message));
      publicRTC.addEventListener('track',event=>{
        const {kind,stream}=event.detail;let element=document.getElementById('public-'+kind);
        if(!element){element=document.createElement(kind==='audio'?'audio':'video');element.id='public-'+kind;element.autoplay=true;element.muted=true;element.playsInline=true;document.body.append(element);}
        element.srcObject=stream;void element.play().catch(error=>publicErrors.push(error.message));
      });
      for(const peer of welcome.peers)publicRTC.addPeer(peer);
      await publicRTC.useSecureRelay();
      window.publicToneContext=new AudioContext({sampleRate:48000});await publicToneContext.resume();
      const output=publicToneContext.createMediaStreamDestination();window.publicTone=publicToneContext.createOscillator();const gain=publicToneContext.createGain();
      publicTone.frequency.value=660;gain.gain.value=.02;publicTone.connect(gain).connect(output);publicTone.start();
      await publicRTC.setTrack('audio',output.stream.getAudioTracks()[0],output.stream);
    },welcome);
    active=true;
    for(const packet of inbox.splice(0))if(packet.type==='signal')chain=chain.then(()=>page.evaluate(packet=>publicRTC.receive(packet.from,packet.data),packet));
    const relayStats=async()=>page.evaluate(async id=>({row:(await publicRTC.stats()).find(value=>value.peerId===id),frames:document.getElementById('public-screen')?.getVideoPlaybackQuality().totalVideoFrames || 0,
      width:document.getElementById('public-screen')?.videoWidth,height:document.getElementById('public-screen')?.videoHeight,
      allDirectClosed:publicPCs.length>0 && publicPCs.every(pc=>pc.connectionState==='closed'),noTurnServers:publicPCs.every(pc=>pc.getConfiguration().iceServers.length===0 && pc.getConfiguration().iceTransportPolicy==='relay')}),peerId);
    recordPublicProgress=async stage=>{
      const stats=await relayStats();
      const summary={stage,route:stats.row?.route || null,width:stats.width || 0,height:stats.height || 0,decodedScreenFrames:stats.frames,
        phoneMicrophonePacketsReceived:stats.row?.receivedAudioPackets || 0,syntheticReversePacketsSent:stats.row?.sentAudioPackets || 0,
        receiverAudioProcessing:stats.row?.playbackContextState || 'off',directConnectionsClosed:stats.allDirectClosed,noTurnServers:stats.noTurnServers,
        encryptedSent:wire.sent,encryptedReceived:wire.received,encryptedEnvelopesOnly:wire.encryptedEnvelopesOnly,
        transportErrors:errors.map(safeError),receiverErrors:await page.evaluate(()=>publicErrors.map(String)).then(values=>values.map(safeError))};
      runtimeDiagnostics.nativePublicRelay=summary;checkpoint('nativePublicRelayProgress',summary);
    };
    await recordPublicProgress('receiverReadyBeforeOwnerMicrophone');
    publicPhase('owner microphone action');
    await tapRoomAction(label('Turn microphone on'));
    publicPhase('owner microphone permission or existing grant');
    const permission=await findNode(node=>label('Turn microphone off')(node) || node['resource-id']==='com.android.permissioncontroller:id/permission_allow_foreground_only_button' || node['resource-id']==='com.android.permissioncontroller:id/permission_allow_button');
    if(!label('Turn microphone off')(permission))await tap(permission);
    await recordPublicProgress('ownerMicrophonePermissionCompleted');
    publicPhase('confirm enabled microphone in scrollable native room');
    await findNativeRoomAction(label('Turn microphone off'));
    publicPhase('owner screen-sharing action');
    await tapRoomAction(label('Share screen'));
    publicPhase('owner Android notification and screen projection consent');
    const captureButton=node=>node.package==='com.android.systemui' && node.class==='android.widget.Button' && /^(Start now|Start recording|Start sharing|Share screen)$/i.test(node.text);
    let capturePermission=await findNode(node=>captureButton(node) || node['resource-id']==='com.android.permissioncontroller:id/permission_allow_button');
    if(!captureButton(capturePermission)){await tap(capturePermission);await findNode(captureButton);}
    publicPhase('owner approves native projection');
    await tapStable(captureButton);
    await recordPublicProgress('ownerApprovedProjectionBeforeRoomConfirmation');
    publicPhase('confirm sharing action in scrollable native room');
    await findNativeRoomAction(node=>/^(Stop sharing(?: screen)?|Stop screen sharing)$/.test(node['content-desc'] || node.text));
    await recordPublicProgress('nativeSharingActionConfirmedBeforeDecodeGate');
    publicPhase('decode actual phone screen at receiver');
    await page.waitForFunction(()=>{const video=document.getElementById('public-screen');return video?.videoWidth>0 && video.readyState>=2 && video.getVideoPlaybackQuality().totalVideoFrames>2;},undefined,{timeout:60000});
    await recordPublicProgress('actualPhoneScreenDecoded');
    publicPhase('require encrypted PCM both directions and closed direct RTC');
    const deadline=Date.now()+45000;let media;
    do {media=await relayStats();if(media.row?.route==='Secure relay' && media.row.receivedAudioPackets>5 && media.row.sentAudioPackets>5 && media.allDirectClosed)break;await delay(300);}while(Date.now()<deadline);
    await recordPublicProgress('screenAndBidirectionalPcmGate');
    assert.equal(media?.row?.route,'Secure relay');assert.ok(media.row.receivedAudioPackets>5 && media.row.sentAudioPackets>5 && media.allDirectClosed && media.noTurnServers);
    let fullscreenProof;
    if(testedMajor>0 || testedMinor>=5) {
      publicPhase('native Android fullscreen presentation');
      const fullscreenProcess=(await adb(['shell','pidof','local.auralink.mobile'])).trim();
      await tapRoomAction(node=>node['resource-id']==='fullscreen-button');
      await findNode((node,nodes)=>node['resource-id']==='presentation-fullscreen-exit' && visibleInWebView(node,nodes));
      await screenshot('android-emulator-fullscreen.png');
      const beforeFullscreenFrames=(await relayStats()).frames;
      await page.waitForFunction(first=>document.getElementById('public-screen')?.getVideoPlaybackQuality().totalVideoFrames>first,beforeFullscreenFrames,{timeout:20000});
      publicPhase('Android Back exits fullscreen without leaving room');
      await adb(['shell','input','keyevent','4']);
      await findNativeRoomAction(node=>node['resource-id']==='fullscreen-button');
      await findNativeRoomAction(node=>node['resource-id']==='room-code' && (node.text || node['content-desc'])===codeText);
      assert.equal((await adb(['shell','pidof','local.auralink.mobile'])).trim(),fullscreenProcess);
      const resumed=(await adb(['shell','dumpsys','activity','activities'])).split('\n').find(line=>line.includes('topResumedActivity='));
      assert.ok(resumed?.includes('local.auralink.mobile'),'Native Back must exit presentation instead of closing the Activity');
      assert.match(await adb(['shell','dumpsys','power']),/PARTIAL_WAKE_LOCK[^\n]*local\.auralink\.mobile:active-room/,'The admitted foreground room must hold its scoped CPU wake lock');
      fullscreenProof={passed:true,visibleExitControl:true,nativeBackRetainsActivityAndRoom:true,screenFramesAdvanced:true,scopedRoomCpuWakeLock:true};
      checkpoint('nativeFullscreen',fullscreenProof);
    }
    publicPhase('open native connection diagnostics');
    await tapRoomAction(node=>node['resource-id']==='diagnostics-toggle');
    publicPhase('confirm native secure-relay route diagnostics');
    await findNativeRoomAction(node=>/Secure relay.*TLS.*WebSocket/.test(node.text || node['content-desc'] || ''));
    publicPhase('read native incoming PCM counter before Home');
    await findNativeRoomAction(node=>(node.text || node['content-desc'])==='Audio received');
    const nativeText=(await hierarchy()).map(node=>node.text || node['content-desc'] || '').join(' ');
    const nativeAudio=/Audio received\s+(\d+) packets/.exec(nativeText);
    assert.ok(nativeAudio && Number(nativeAudio[1])>5,'Actual Android public relay must decode incoming PCM packets');
    publicPhase('close native diagnostics before Home');
    await tapRoomAction(node=>node['resource-id']==='diagnostics-close');
    const processBefore=(await adb(['shell','pidof','local.auralink.mobile'])).trim();
    const imageHash=()=>page.evaluate(()=>{const video=document.getElementById('public-screen');const canvas=document.createElement('canvas');canvas.width=90;canvas.height=160;canvas.getContext('2d').drawImage(video,0,0,90,160);let hash=2166136261;for(const value of canvas.getContext('2d').getImageData(0,0,90,160).data)hash=Math.imul(hash^value,16777619);return hash>>>0;});
    const homeComponent=(await adb(['shell','cmd','package','resolve-activity','--brief','-a','android.intent.action.MAIN','-c','android.intent.category.HOME'])).trim().split(/\r?\n/).find(line=>/^[\w.]+\//.test(line));
    assert.ok(homeComponent);const homePackage=homeComponent.split('/')[0];
    publicPhase('actual Android Home remains foreground');
    await adb(['shell','input','keyevent','3']);await findNode(node=>node.package===homePackage);await delay(1500);
    publicPhase('change Home pixels and require background screen and audio upload');
    const before=await relayStats(),oldPixels=await imageHash();await adb(['shell','input','keyevent','24']);
    const backgroundDeadline=Date.now()+30000;let background;
    do {background=await relayStats();if(background.frames>before.frames && background.row.receivedAudioPackets>before.row.receivedAudioPackets && background.row.sentAudioPackets>before.row.sentAudioPackets && await imageHash()!==oldPixels)break;await delay(300);}while(Date.now()<backgroundDeadline);
    await recordPublicProgress('actualHomeMediaGate');
    assert.ok(background.frames>before.frames && background.row.receivedAudioPackets>before.row.receivedAudioPackets && background.row.sentAudioPackets>before.row.sentAudioPackets && await imageHash()!==oldPixels,'Native screen pixels, phone microphone upload and reverse PCM transmission must advance during actual Home');
    const top=(await adb(['shell','dumpsys','activity','activities'])).split('\n').find(line=>line.includes('topResumedActivity='));assert.ok(top?.includes(homePackage),'Actual Android Home remains foreground while media advances');
    publicPhase('verify native microphone foreground service and projection during Home');
    await callServiceTypes(0x10|0x80);assert.match(await adb(['shell','dumpsys','media_projection']),/local\.auralink\.mobile/);
    // Stop only the synthetic sender's local capture before bringing Android
    // back. Keep the remote audio track advertised, so its processing context
    // remains observable. The returned counter cannot be supplied by a freshly
    // restarted sender; this proves delivery across Home/return, without
    // claiming exactly when a hidden decoder ran or that a speaker was audible.
    publicPhase('stop synthetic reverse sender while Home remains foreground');
    await page.evaluate(async id=>{
      publicRTC.relayMedia.stopSource('audio');
      publicTone?.stop();publicTone?.disconnect();window.publicTone=null;
      await publicRTC.relayMedia.peers.get(id)?.sendQueue;
    },peerId);
    const reversePacketsWhenStopped=(await relayStats()).row.sentAudioPackets;
    await delay(1000);
    assert.equal((await relayStats()).row.sentAudioPackets,reversePacketsWhenStopped,'Synthetic reverse PCM must remain stopped before Android returns');
    const stoppedTop=(await adb(['shell','dumpsys','activity','activities'])).split('\n').find(line=>line.includes('topResumedActivity='));
    assert.ok(stoppedTop?.includes(homePackage),'Android Home must remain foreground when the reverse sender stops');
    await recordPublicProgress('reverseSenderStoppedDuringHome');
    publicPhase('return to actual Android room and confirm microphone remains enabled');
    await adb(['shell','am','start','-n','local.auralink.mobile/.MainActivity']);await findNativeRoomAction(label('Turn microphone off'));
    assert.equal((await adb(['shell','pidof','local.auralink.mobile'])).trim(),processBefore);
    publicPhase('confirm original public room capability retained after Home');
    await findNativeRoomAction(node=>node['resource-id']==='room-code' && (node.text || node['content-desc'])===codeText);
    await recordPublicProgress('originalRoomRetainedAfterHome');
    publicPhase('open returned native connection diagnostics');
    await tapRoomAction(node=>node['resource-id']==='diagnostics-toggle');
    publicPhase('require native incoming PCM advanced across Home and return');
    await findNativeRoomAction(node=>(node.text || node['content-desc'])==='Audio received');
    const returnedAudioText=(await hierarchy()).map(node=>node.text || node['content-desc'] || '').join(' ');
    const returnedAudio=/Audio received\s+(\d+) packets/.exec(returnedAudioText);
    assert.ok(returnedAudio && Number(returnedAudio[1])>Number(nativeAudio[1]),'Android incoming PCM must advance across Home/return after the reverse sender has stopped');
    publicPhase('require native audio playback processing running after return');
    await findNativeRoomAction(node=>(node.text || node['content-desc'])==='Audio playback processing');
    const returnedProcessingText=(await hierarchy()).map(node=>node.text || node['content-desc'] || '').join(' ');
    const returnedProcessing=/Audio playback processing\s+(running|suspended|interrupted|off)/.exec(returnedProcessingText);
    assert.equal(returnedProcessing?.[1],'running','Android incoming PCM playback processing must be running after Home/return');
    assert.equal((await relayStats()).row.sentAudioPackets,reversePacketsWhenStopped,'The synthetic reverse sender must remain stopped through the returned Android counter check');
    publicPhase('close returned native connection diagnostics');
    await tapRoomAction(node=>node['resource-id']==='diagnostics-close');
    const summary={passed:true,coordinator:'Deployed public Worker via native system PKI and Node hostname-verified WSS',route:'Secure relay',directRTCImpossible:true,allDirectClosed:true,
      actualProjection:{width:background.width,height:background.height,decodedFrames:background.frames,changedPixelsDuringHome:true},
      audio:{phoneMicrophonePcmPacketsReceived:background.row.receivedAudioPackets,syntheticReversePcmPacketsSent:reversePacketsWhenStopped,actualAndroidPcmPacketsDecoded:Number(returnedAudio[1]),
        actualAndroidPcmPacketsBeforeHome:Number(nativeAudio[1]),actualAndroidPcmPacketsAfterHomeReturn:Number(returnedAudio[1]),reversePcmDeliveredAcrossHomeReturn:true,
        reverseSenderStoppedWhileHomeForeground:true,playbackProcessingAfterReturn:returnedProcessing[1],exactHiddenDecoderTimingVerified:false,physicalMicrophoneAndSpeakerVerified:false},
      encryptedEnvelopesOnly:wire.encryptedEnvelopesOnly,encryptedSent:wire.sent,encryptedReceived:wire.received,homeMediaAdvanced:true,sameProcessAndRoomOnReturn:true,newCaptureAndControlRemainConsentRequired:true,...(fullscreenProof?{fullscreen:fullscreenProof}:{})};
    assert.equal(wire.encryptedEnvelopesOnly,true);assert.deepEqual(errors,[]);assert.deepEqual(await page.evaluate(()=>publicErrors),[]);
    checkpoint('nativePublicRelayMedia',summary);
    publicPhase('owner stops public screen share');
    await tapRoomAction(node=>/^(Stop sharing(?: screen)?|Stop screen sharing)$/.test(node['content-desc'] || node.text));await findNativeRoomAction(label('Share screen'));
    publicPhase('owner stops public microphone');
    await tapRoomAction(label('Turn microphone off'));await findNativeRoomAction(label('Turn microphone on'));
    publicPhase('confirm owner projection cleanup');
    assert.ok(!(await adb(['shell','dumpsys','media_projection'])).includes('local.auralink.mobile'));
  } catch(error) {
    // Capture fresh safe receiver counters before teardown even when a native
    // UI lookup times out. Never retain invitations, peer IDs or media payloads.
    await recordPublicProgress?.('failedPublicRelayStage').catch(()=>{});
    throw error;
  } finally {
    clearInterval(heartbeat);
    active=false;socket.removeAllListeners('message');await chain.catch(()=>{});
    for(const pending of waiters)clearTimeout(pending.timer);
    if(page) {await page.evaluate(async()=>{publicRTC?.close();publicTone?.stop();await publicToneContext?.close();}).catch(()=>{});await page.close().catch(()=>{});}
    if(socket.readyState===WebSocket.OPEN)send({type:'leave'});socket.close();
  }
}

async function runUI(fixture) {
  phase='production APK lobby';console.log(phase);
  await findNode(node=>node.package==='local.auralink.mobile' && /Rooms|Your space|Settings/.test(node.text),60000);await screenshot('android-emulator-lobby.png');
  checkpoint('productionLobbyRendered');
  if (publicLifecycleRegression) await checkPublicRoomStart(fixture);
  else if (freshSetupRegression) await checkFreshInternetSetup(fixture);
  if(process.argv.includes('--control')) {
    // Start after cold WebView startup instead of racing the Accessibility
    // binding deadline with first-launch provider initialization. Only this
    // verified throwaway AVD uses ADB; real owners use Android Settings.
    await adb(['shell','settings','put','secure','enabled_accessibility_services','local.auralink.mobile/local.auralink.mobile.AttendedAccessibilityService']);
    await adb(['shell','settings','put','secure','accessibility_enabled','1']);
    await accessibilityBound();checkpoint('actualAccessibilityServiceBound');
  }
  await tapRoomAction(node=>node['resource-id']==='join-button');
  phase='production invitation dialog';
  await invitationFields();
  await screenshot('android-emulator-invitation-dialog.png');
  checkpoint('invitationDialogRendered');
  console.log('Production invitation dialog exposes both Android text inputs');
  await typeInvitation(fixture.invite);
  // Back may exit the Activity if a hardware keyboard suppressed the IME.
  // Dismiss it only when Android actually exposes its input view as visible.
  runtimeDiagnostics.invitation.keyboardVisible=await keyboardShown();
  if(runtimeDiagnostics.invitation.keyboardVisible) {
    await adb(['shell','input','keyevent','4']);
    const deadline=Date.now()+10000;
    while(await keyboardShown()){assert.ok(Date.now()<deadline,'Android keyboard must hide before submitting');await delay(300);}
  }
  console.log('Pinned invitation entered through the production Android text field');
  const submit=await tapStable(label('Request to join'));
  runtimeDiagnostics.invitation.submitBounds=submit.bounds;
  phase='native pinned invitation admission';
  await fixture.take('join-request',45000);
  await findNativeRoomAction(label('Turn microphone on'),45000);await screenshot('android-emulator-room.png');
  checkpoint('nativePinnedRoomAdmitted');
  const audio=await startPhoneAudio(fixture);
  checkpoint('actualAudioTransport',audio);
  if(publicLifecycleRegression)await checkCallHomeReturn(fixture,audio);
  phase='Android owner screen permission';console.log(phase);
  await tapRoomAction(label('Share screen'));
  const systemCaptureButton=node=>node.package==='com.android.systemui' && node.class==='android.widget.Button' && /^(Start now|Start recording|Start sharing|Share screen)$/i.test(node.text);
  let permission=await findNode(node=>systemCaptureButton(node) || node['resource-id']==='com.android.permissioncontroller:id/permission_allow_button',30000);
  if(permission['resource-id']==='com.android.permissioncontroller:id/permission_allow_button') {
    await tap(permission);permission=await findNode(systemCaptureButton,30000);
  }
  await screenshot('android-emulator-projection-permission.png');await tapStable(systemCaptureButton);
  const sharingLabel=node=>/^(Stop sharing(?: screen)?|Stop screen sharing)$/.test(node['content-desc'] || node.text);
  try {
    const started=await findNativeRoomAction(node=>sharingLabel(node) || /^(?:Screen capture could not start|Screen delivery stalled|Screen frame conversion failed|Screen sharing was canceled|Sharing failed:|Screen share failed:)/.test(node.text || ''),30000);
    if(!sharingLabel(started)) throw new Error(safeError(started.text || started['content-desc'] || 'Phone capture did not start.'));
    checkpoint('nativeCaptureStartedAfterOwnerConsent');
  } catch(error) {
    const state=await adb(['shell','dumpsys','activity','services','local.auralink.mobile']).catch(()=> 'Service state unavailable');
    runtimeDiagnostics.screenStart={captureServicePresent:state.includes('ScreenShareService'),foreground:state.includes('isForeground=true')};
    throw error;
  }
  phase='actual Android screen frames over WebRTC';console.log(phase);
  await fixture.page.waitForFunction(()=>{const video=document.getElementById('received-screen');return video && video.videoWidth>0 && video.currentTime>0 && video.readyState>=2;},undefined,{timeout:60000});
  const screen=await fixture.page.locator('#received-screen').evaluate(video=>({width:video.videoWidth,height:video.videoHeight,currentTime:video.currentTime,readyState:video.readyState}));
  checkpoint('actualScreenDecoded',screen);
  await screenshot('android-emulator-sharing.png');
  const service=await adb(['shell','dumpsys','activity','services','local.auralink.mobile']);
  assert.match(service,/ScreenShareService/);assert.match(service,/isForeground=true/);
  const foregroundType=service.match(/isForeground=true[^\n]*\btypes=(?:0x)?([a-f0-9]+)/i);
  assert.ok(foregroundType && (parseInt(foregroundType[1],16)&0x80)!==0,'Active screen sharing with microphone must declare the microphone foreground service type');
  audio.checks.push('Screen projection declares active microphone foreground service type');
  checkpoint('foregroundProjectionAndMicrophoneService');
  if(publicLifecycleRegression)await checkProjectionRotation(fixture);
  let control=null;
  if(process.argv.includes('--control')) {
    phase='separate attended phone control approval';console.log(phase);
    await accessibilityBound();checkpoint('accessibilityServiceStillBoundBeforeApproval');
    await fixture.page.waitForFunction(id=>rtc.peers.get(id)?.channel?.readyState==='open',fixture.peerId,{timeout:30000});
    fixture.send({type:'control-request',to:fixture.peerId});
    await tapRoomAction(label('Review and allow'),30000);
    await screenshot('android-emulator-native-control-consent.png');
    await tapStable(node=>node['resource-id']==='android:id/button1' && /^allow control$/i.test(node.text),30000);
    const grant=await fixture.take('control-response',30000);
    assert.equal(grant.from,fixture.peerId);assert.equal(grant.accepted,true,`Native owner approval must succeed: ${runtimeDiagnostics.nativeControlResponse?.reason || 'No native reason'}`);
    await findNode(node=>node['content-desc']==='Stop remote control immediately',30000);
    checkpoint('separateNativeControlApproved');
    phase='actual Android Accessibility input';console.log(phase);
    const homeComponent=(await adb(['shell','cmd','package','resolve-activity','--brief','-a','android.intent.action.MAIN','-c','android.intent.category.HOME'])).trim().split(/\r?\n/).find(line=>/^[\w.]+\//.test(line));
    assert.ok(homeComponent,'The isolated Android emulator must expose a HOME activity');
    const homePackage=homeComponent.split('/')[0];
    await fixture.page.evaluate(({peerId,sessionId})=>{
      const send=event=>rtc.sendData(peerId,{type:'input',sessionId,event});
      send({type:'keydown',code:'Home',seq:1});send({type:'keyup',code:'Home',seq:2});
    },{peerId:fixture.peerId,sessionId:grant.sessionId});
    await findNode(node=>node.package===homePackage,30000);
    await screenshot('android-emulator-remotely-opened-home.png');
    assert.match(await adb(['shell','dumpsys','media_projection']),/local\.auralink\.mobile/,'Attended control must keep the explicitly approved projection active');
    checkpoint('realRemoteHomeWithProjectionActive');
    const backgroundFrames=await fixture.page.locator('#received-screen').evaluate(video=>video.getVideoPlaybackQuality().totalVideoFrames);
    const imageHash=async()=>crypto.createHash('sha256').update(await fixture.page.locator('#received-screen').evaluate(video=>{
      const canvas=document.createElement('canvas');canvas.width=video.videoWidth;canvas.height=video.videoHeight;
      canvas.getContext('2d').drawImage(video,0,0);return canvas.toDataURL('image/png');
    })).digest('hex');
    const previousImage=await imageHash();
    // MediaProjection delivers composed buffers, not a perpetual timer. A
    // settled Home screen can remain static. Make a real owner-visible change
    // AFTER the baseline, then require fresh decoded pixels in the receiver.
    await adb(['shell','input','keyevent','24']);
    await fixture.page.waitForFunction(first=>document.getElementById('received-screen')?.getVideoPlaybackQuality().totalVideoFrames>first,backgroundFrames,{timeout:20000});
    const changedDeadline=Date.now()+10000;
    while(await imageHash()===previousImage){assert.ok(Date.now()<changedDeadline,'Background screen pixels must change after the actual owner volume action');await delay(200);}
    const backgroundResumed=(await adb(['shell','dumpsys','activity','activities'])).split('\n').find(line=>line.includes('topResumedActivity='));
    assert.ok(backgroundResumed?.includes(homePackage),'The actual phone must still show Home while new screen pixels decode');
    checkpoint('screenFramesContinueWhilePhoneShowsHome',{passed:true,ownerVisibleChange:'Android volume panel',newDecodedFrame:true,decodedPixelsChanged:true,homeRemainsForeground:true});
    await adb(['shell','am','start','-n','local.auralink.mobile/.MainActivity']);
    await tap(await findNode(node=>node['content-desc']==='Stop remote control immediately',30000));
    await fixture.take('control-revoke',30000);
    await fixture.page.waitForFunction(id=>rtc.peers.get(id)?.channel?.readyState==='open',fixture.peerId,{timeout:15000});
    const staleSent=await fixture.page.evaluate(({peerId,sessionId})=>{
      return [rtc.sendData(peerId,{type:'input',sessionId,event:{type:'keydown',code:'Home',seq:3}}),
        rtc.sendData(peerId,{type:'input',sessionId,event:{type:'keyup',code:'Home',seq:4}})];
    },{peerId:fixture.peerId,sessionId:grant.sessionId});
    assert.deepEqual(staleSent,[true,true],'The stale-session test must actually send both input packets');
    await delay(1000);
    const resumed=(await adb(['shell','dumpsys','activity','activities'])).split('\n').find(line=>line.includes('topResumedActivity='));
    assert.match(resumed || '',/local\.auralink\.mobile/,'Revoked input must not reopen Home');
    checkpoint('ownerControlRevokeAndStaleInputRejected');
    control={passed:true,checks:['Separate in-app and native owner approval','Real encrypted RTC input received by Accessibility service','Remote Home action changes actual Android app','New decoded screen pixels after an actual owner volume action while Home remains foreground','Foreground sharing remains during approved background control','Owner floating Stop control revokes broker grant','Stale session input rejected after stop']};
  }
  phase='owner screen stop and projection cleanup';console.log(phase);
  await tapRoomAction(node=>/^(Stop sharing(?: screen)?|Stop screen sharing)$/.test(node['content-desc'] || node.text),20000);
  await delay(1500);
  const stopped=await adb(['shell','dumpsys','media_projection']);
  assert.ok(!stopped.includes('local.auralink.mobile'),'Stopping share must remove MediaProjection');
  checkpoint('ownerScreenStopReleasedProjection');
  phase='owner microphone stop and call audio cleanup';console.log(phase);
  await tapRoomAction(label('Turn microphone off'));
  await findNativeRoomAction(label('Turn microphone on'));
  await fixture.page.waitForFunction(id=>rtc.peers.get(id)?.remoteState.audio===false,fixture.peerId,{timeout:15000});
  await tapRoomAction(label('Leave room'));
  await findNativeRoomAction(node=>node['resource-id']==='join-button' && node.enabled==='true');
  if(testedMajor>0 || testedMinor>=5) {
    const deadline=Date.now()+10000;let power;
    do { power=await adb(['shell','dumpsys','power']);if(!/PARTIAL_WAKE_LOCK[^\n]*local\.auralink\.mobile:active-room/.test(power))break;await delay(300); }while(Date.now()<deadline);
    assert.doesNotMatch(power,/PARTIAL_WAKE_LOCK[^\n]*local\.auralink\.mobile:active-room/,'Leaving the room must release its CPU wake lock');
    checkpoint('roomWakeLockReleasedOnLeave',{passed:true});
  }
  await audioMode('MODE_NORMAL');
  audio.checks.push('Owner microphone stop updates receiver media state','Leaving the room releases Android communication audio mode');
  checkpoint('ownerAudioStopAndRouteCleanup');
  const processId=(await adb(['shell','pidof','local.auralink.mobile'])).trim();
  assert.match(processId,/^\d+$/,'The actual Android app must remain alive after sharing');
  const fatal=(await adb(['shell','logcat','-d',`--pid=${processId}`,'-s','AndroidRuntime:E'])).trim();
  assert.ok(!fatal.includes('FATAL EXCEPTION'),fatal);
  await fixture.chain;
  assert.deepEqual(fixture.errors,[]);
  assert.deepEqual(await fixture.page.evaluate(()=>runtimeErrors),[]);
  const sourceCheck=path.join(project,'.tools','runtime-source-check.json');
  return {passed:true,version:process.env.AURALINK_TEST_APK_VERSION || pkg.version,baselineOverride:Boolean(process.env.AURALINK_TEST_APK),receiverRendererOverride:Boolean(process.env.AURALINK_TEST_RENDERER_DIR),serial,api:36,apkSha256:installedApkHash,source:fs.existsSync(sourceCheck)?JSON.parse(fs.readFileSync(sourceCheck,'utf8')):null,diagnostics:runtimeDiagnostics,verifiedStages,screen,control,audio,
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
    try {
      const appPid=(await adb(['shell','pidof','local.auralink.mobile'])).trim();
      if(/^\d+$/.test(appPid)) {
        const log=await adb(['shell','logcat','-d',`--pid=${appPid}`,'-s','AndroidRuntime:E','chromium:E','WebViewFactory:E']);
        fs.writeFileSync(path.join(output,'android-emulator-native-errors-raw.txt'),log);
        runtimeDiagnostics.nativeErrors=safeError(log).slice(-6000);
      }
    }catch{}
    fs.writeFileSync(path.join(output,'android-emulator.json'),JSON.stringify({passed:false,version:process.env.AURALINK_TEST_APK_VERSION || pkg.version,baselineOverride:Boolean(process.env.AURALINK_TEST_APK),receiverRendererOverride:Boolean(process.env.AURALINK_TEST_RENDERER_DIR),serial,api:36,apkSha256:installedApkHash,phase,error:safeError(error),verifiedStages,diagnostics:runtimeDiagnostics,network:fixture?.network,ui:diagnostics},null,2));throw new Error(safeError(error));
  }finally {
    if(fixture){
      // Stop accepting signaling before closing either endpoint, then finish
      // every active-phase delivery while its receiver page is still alive.
      fixture.ws.removeAllListeners('message');
      try{fixture.ws.close();}catch{}
      await fixture.chain;
    }
    if(!process.argv.includes('--fixture-only')) await adb(['shell','am','force-stop','local.auralink.mobile']).catch(()=>{});
    if(fixture){
      for(const waiter of fixture.waiters)clearTimeout(waiter.timer);
      await fixture.browser?.close().catch(()=>{});
      await fixture.broker.stop().catch(()=>{});
      fixture.restoreObserver?.();
    }
  }
}
main().catch(error=>{console.error(`Android emulator check failed during ${phase}: ${safeError(error)}`);process.exitCode=1;});
