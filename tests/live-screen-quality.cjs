'use strict';

// Real owner-approved desktop capture and shipped RoomRTC / encrypted relay.
// Isolated test peers signal in memory; no public provider or OS input is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const {createHash} = require('node:crypto');
const {_electron} = require('playwright');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'test-results');
const sourceFiles = ['src/main.cjs', 'src/preload.cjs', 'src/renderer/app.js', 'src/renderer/index.html', 'src/renderer/styles.css', 'src/renderer/rtc.js', 'src/renderer/relay-media.js'];
const hashes = () => Object.fromEntries(sourceFiles.map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
async function availablePort() {
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}

async function main() {
  fs.mkdirSync(output, {recursive:true});
  const profile = fs.mkdtempSync(path.join(output, 'live-quality-profile-'));
  let application, page, phase = 'launch'; const errors = [];
  const proof = {passed:false, platform:process.platform, sourceHashes:hashes(),
    boundary:'Production Electron main/preload source selection and getDisplayMedia capture a separately owned native1920×1080 Electron window containing animated QA pixels, even when the desktop is smaller. Active production owner RoomRTC uses isolated in-memory-signaled real direct RTC and encrypted relay peers. Main app fullscreen UI changes actual native capture constraints. Real changing captured pixels and decoded dimensions are checked without saving screen images. No synthetic capture track, physical microphone, remote OS input, public relay quota or different-network claim.'};
  try {
    const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
    application = await _electron.launch({args:[root, '--smoke-test', `--user-data-dir=${profile}`, '--mute-audio', '--autoplay-policy=no-user-gesture-required'], env, timeout:60000});
    page = await application.firstWindow(); page.on('pageerror', error => errors.push(error.message));
    await page.locator('#host-button').waitFor();
    await page.locator('.advanced-connections > summary').click(); await page.locator('#advanced-host-button').click();
    await page.locator('#host-mode').selectOption('nearby'); await page.locator('#host-name').fill('Live native screen quality regression');
    await page.locator('#host-port').fill(String(await availablePort())); await page.locator('#create-room').click();
    await page.locator('#invite-dialog').waitFor({state:'visible'}); await page.locator('#invite-dialog [data-close]').click();
    await page.evaluate(async () => {
      const {RoomRTC} = await import('./rtc.js');
      const original = RoomRTC.prototype.setTrack;
      window.liveQualityQA = {owner:null, errors:[], peers:new Map(), envelopes:0, captures:0, microphoneCalls:0, trackEvents:{}, changes:[]};
      RoomRTC.prototype.setTrack = function(kind, track, stream) {
        if (kind === 'screen' && track) { liveQualityQA.owner = this; liveQualityQA.originalTrack = track; }
        return original.call(this, kind, track, stream);
      };
      const display = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getDisplayMedia = async options => { liveQualityQA.captures++; return display(options); };
      const microphone = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async options => { liveQualityQA.microphoneCalls++; return microphone(options); };
    });
    phase = 'create independent native capture window';
    proof.fixtureWindow=await application.evaluate(async ({BrowserWindow,screen}) => {
      const owner=BrowserWindow.getAllWindows()[0];
      const fixture=new BrowserWindow({width:1920,height:1080,minWidth:1920,minHeight:1080,useContentSize:true,frame:false,
        show:false,focusable:false,skipTaskbar:true,backgroundColor:'#583f39',title:'Glance-Port isolated live quality capture',
        ...(process.platform==='darwin'?{enableLargerThanScreen:true}:{}),
        webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
      globalThis.liveQualityCaptureFixture=fixture;
      await fixture.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(`<!doctype html><html><head><title>Glance-Port isolated live quality capture</title><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'"></head><body style="margin:0;background:#583f39;overflow:hidden"><canvas id="motion" width="1920" height="1080" style="display:block;width:1920px;height:1080px"></canvas><script>
        window.qaPaints=0;const canvas=document.getElementById('motion'),ctx=canvas.getContext('2d');
        function paint(){const count=++window.qaPaints;ctx.fillStyle=count%2?'#583f39':'#8c4554';ctx.fillRect(0,0,1920,1080);
          ctx.fillStyle='#faf0c4';ctx.fillRect(count*23%1760,300,160,450);ctx.font='64px sans-serif';ctx.fillText('Native screen quality '+count,90,150);
          ctx.fillStyle='#d7a6c1';ctx.fillRect(1850,1010,50,50);}
        paint();window.qaMotion=setInterval(paint,40);
      </script></body></html>`));
      // Set client bounds after load/show as well; a runner's smaller work area
      // must not silently substitute its own size for this native source.
      fixture.showInactive();fixture.setContentBounds({x:0,y:0,width:1920,height:1080});owner.focus();
      return {bounds:fixture.getBounds(),contentBounds:fixture.getContentBounds(),visible:fixture.isVisible(),minimized:fixture.isMinimized(),
        desktop:screen.getPrimaryDisplay().size,deviceScaleFactor:screen.getPrimaryDisplay().scaleFactor,
        sourceId:fixture.getMediaSourceId(),nativeSourceCreated:true};
    });
    assert.equal(proof.fixtureWindow.contentBounds.width,1920);assert.equal(proof.fixtureWindow.contentBounds.height,1080);
    assert.equal(proof.fixtureWindow.visible,true);assert.equal(proof.fixtureWindow.minimized,false);
    phase = 'native capture';
    await page.locator('#share-button').click(); await page.locator('.screen-source').filter({hasText:'Glance-Port isolated live quality capture'}).click();
    await page.waitForFunction(() => liveQualityQA.owner && document.getElementById('stage-video').videoWidth > 0, null, {timeout:25000});
    const native = await page.evaluate(() => liveQualityQA.originalTrack.getSettings());
    assert.ok(native.width > 1280 || native.height > 720, 'Selected native window must exceed 720p to demonstrate a real live downscale');
    proof.nativeSource = {width:native.width, height:native.height, displaySurface:native.displaySurface};
    assert.equal(native.displaySurface,'window');
    assert.equal(native.deviceId,proof.fixtureWindow.sourceId,'Native capture must belong to the uniquely owned test window');
    assert.equal(native.width,1920);assert.equal(native.height,1080,'Actual native source pixels must remain independent from the smaller desktop');
    phase = 'direct and encrypted relay peers';
    await page.evaluate(async () => {
      const {RoomRTC} = await import('./rtc.js'); const {RelayMedia} = await import('./relay-media.js'); const qa = liveQualityQA, owner = qa.owner;
      const secret = crypto.getRandomValues(new Uint8Array(32)); const key = btoa(String.fromCharCode(...secret)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
      const signal = owner.signal;
      owner.signal = (id, data) => {
        const peer = qa.peers.get(id); if (!peer) return signal(id, data);
        if (data.relay) { if (Object.keys(data).length !== 1 || typeof data.relay.ciphertext !== 'string') throw new Error('Relay signaling must contain an encrypted envelope only'); qa.envelopes++; }
        queueMicrotask(() => peer.receive(owner.selfId, data)); return true;
      };
      owner.websocketRelayEnabled = true; owner.relayMedia = new RelayMedia(owner, key); owner.relayReady = Promise.resolve(owner.relayMedia);
      qa.addPeer = async (id, relay) => {
        const peer = new RoomRTC({selfId:id, signal(_to, data) { queueMicrotask(() => owner.receive(id, data)); return true; },
          iceServers:[], websocketRelayEnabled:relay, ...(relay ? {relayKey:key, iceTransportPolicy:'relay'} : {})});
        qa.peers.set(id, peer); qa.trackEvents[id] = 0;
        peer.addEventListener('error', event => qa.errors.push(event.detail.error?.message));
        peer.addEventListener('track', event => { if (event.detail.kind !== 'screen') return;
          qa.trackEvents[id]++; let video = document.getElementById(`live-quality-${id}`);
          if (!video) { video = document.createElement('video'); video.id = `live-quality-${id}`; video.muted = true; video.autoplay = true; video.playsInline = true;
            Object.assign(video.style, {position:'fixed', bottom:'0', right:'0', width:'1px', height:'1px', opacity:'0', pointerEvents:'none'}); document.body.append(video); }
          video.srcObject = event.detail.stream; void video.play();
        });
        peer.addPeer({id:owner.selfId, name:'Native owner'}); owner.addPeer({id, name:'Isolated live quality receiver'});
        if (relay) { await peer.relayReady; await Promise.all([owner.activateRelay(owner.peers.get(id)), peer.activateRelay(peer.peers.get(owner.selfId))]); }
      };
      await qa.addPeer('quality-direct', false); await qa.addPeer('quality-relay', true);
      qa.stop = () => { for (const [id, peer] of qa.peers) { peer.close(); owner.removePeer(id); document.getElementById(`live-quality-${id}`)?.remove(); } qa.peers.clear(); };
    });
    await page.waitForFunction(() => ['quality-direct','quality-relay'].every(id => { const video = document.getElementById(`live-quality-${id}`); return video?.videoWidth > 0 && video.getVideoPlaybackQuality().totalVideoFrames > 3; }), null, {timeout:30000});
    await page.locator('#fullscreen-button').click(); await page.locator('#presentation-quality').waitFor({state:'visible'});
    assert.equal(await page.locator('#presentation-quality').isEnabled(), true);
    proof.changes = [];
    for (const quality of ['720','1080','1440','720']) {
      phase = `live ${quality} quality`; await page.locator('#presentation-quality').selectOption(quality);
      await page.waitForFunction(quality => {
        const qa = liveQualityQA, owner = qa.owner, track = owner.localTracks.get('screen')?.track;
        const limits = {auto:[1920,1080],720:[1280,720],1080:[1920,1080],1440:[2560,1440]}[quality], settings = track?.getSettings();
        const source = owner.relayMedia.sources.get('screen'), direct = owner.peers.get('quality-direct')?.senders.get('screen');
        const directVideo = document.getElementById('live-quality-quality-direct'), relayVideo = document.getElementById('live-quality-quality-relay');
        const cap = {auto:3500000,720:2200000,1080:4500000,1440:7000000}[quality];
        return owner.quality === quality && settings?.width <= limits[0] && settings?.height <= limits[1] &&
          direct?.getParameters().encodings[0]?.maxBitrate === cap && directVideo?.videoWidth === settings.width && directVideo?.videoHeight === settings.height &&
          source?.quality === quality && relayVideo?.videoWidth === source.width && relayVideo?.videoHeight === source.height &&
          Math.max(relayVideo.videoWidth,relayVideo.videoHeight) <= limits[0];
      }, quality, {timeout:20000});
      const measurement = await page.evaluate(async quality => {
        const qa = liveQualityQA, owner = qa.owner, track = owner.localTracks.get('screen').track;
        const videos = ['quality-direct','quality-relay'].map(id => document.getElementById(`live-quality-${id}`));
        const baseline = videos.map(video => ({frames:video.getVideoPlaybackQuality().totalVideoFrames, track:video.srcObject.getVideoTracks()[0]}));
        const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 90; const ctx = canvas.getContext('2d',{willReadFrequently:true});
        const seen = videos.map(() => new Set());
        for (let iteration = 0; iteration < 12; iteration++) { await new Promise(resolve => setTimeout(resolve,80)); videos.forEach((video,index) => {
          ctx.drawImage(video,0,0,160,90); const pixels = ctx.getImageData(0,0,160,90).data; let hash = 2166136261;
          for (let offset = 0; offset < pixels.length; offset += 16) hash = Math.imul(hash ^ pixels[offset], 16777619); seen[index].add(hash >>> 0);
        }); }
        const source = owner.relayMedia.sources.get('screen');
        return {quality, settings:track.getSettings(), constraints:track.getConstraints(), sameCapture:track === qa.originalTrack,
          fullscreen:document.getElementById('stage').classList.contains('presentation-active') || document.fullscreenElement === document.getElementById('stage'),
          selected:[...['quality-select','settings-quality','presentation-quality'].map(id => document.getElementById(id).value)],
          directParameters:owner.peers.get('quality-direct').senders.get('screen').getParameters().encodings[0],
          relay:{width:source.width,height:source.height,codec:source.codec,bitrate:source.config.bitrate},
          receivers:videos.map((video,index) => ({width:video.videoWidth,height:video.videoHeight,frames:video.getVideoPlaybackQuality().totalVideoFrames-baseline[index].frames,
            sameTrack:video.srcObject.getVideoTracks()[0] === baseline[index].track,trackEvents:qa.trackEvents[['quality-direct','quality-relay'][index]],changingHashes:seen[index].size})),
          captureCalls:qa.captures,microphoneCalls:qa.microphoneCalls,envelopes:qa.envelopes,errors:qa.errors};
      }, quality);
      assert.equal(measurement.sameCapture,true); assert.equal(measurement.fullscreen,true); assert.deepEqual(measurement.selected,[quality,quality,quality]);
      assert.equal(measurement.captureCalls,1); assert.equal(measurement.microphoneCalls,0); assert.deepEqual(measurement.errors,[]);
      for (const receiver of measurement.receivers) { assert.equal(receiver.sameTrack,true); assert.equal(receiver.trackEvents,1); assert.ok(receiver.frames>3 && receiver.changingHashes>=2, JSON.stringify(measurement)); }
      proof.changes.push(measurement);
    }
    assert.ok(proof.changes[1].settings.width > proof.changes[0].settings.width || proof.changes[1].settings.height > proof.changes[0].settings.height, '1080p must restore useful actual native dimensions after720p');
    phase = 'rapid selections preserve the latest live ceiling';
    for (const quality of ['1080','1440','720']) await page.locator('#presentation-quality').selectOption(quality);
    await page.waitForFunction(() => {
      const qa=liveQualityQA, track=qa.originalTrack, constraints=track.getConstraints(), source=qa.owner.relayMedia.sources.get('screen');
      const direct=document.getElementById('live-quality-quality-direct'), relay=document.getElementById('live-quality-quality-relay');
      return qa.owner.quality==='720' && constraints.width?.max===1280 && constraints.height?.max===720 &&
        track.getSettings().width<=1280 && track.getSettings().height<=720 && source?.quality==='720' &&
        Math.max(source.width,source.height)<=1280 && direct?.videoWidth<=1280 && direct?.videoHeight<=720 &&
        relay?.videoWidth===source.width && relay?.videoHeight===source.height &&
        qa.owner.peers.get('quality-direct').senders.get('screen').getParameters().encodings[0]?.maxBitrate===2200000;
    }, null, {timeout:20000});
    proof.rapidSelections=await page.evaluate(() => ({lastSelection:'720',outgoingQuality:liveQualityQA.owner.quality,
      actualCapture:{width:liveQualityQA.originalTrack.getSettings().width,height:liveQualityQA.originalTrack.getSettings().height},
      sameCapture:liveQualityQA.owner.localTracks.get('screen').track===liveQualityQA.originalTrack,
      captureCalls:liveQualityQA.captures,selected:['quality-select','settings-quality','presentation-quality'].map(id=>document.getElementById(id).value)}));
    assert.equal(proof.rapidSelections.sameCapture,true);assert.equal(proof.rapidSelections.captureCalls,1);assert.deepEqual(proof.rapidSelections.selected,['720','720','720']);
    phase = 'late direct peer inherits current ceiling';
    await page.evaluate(() => liveQualityQA.addPeer('quality-late',false));
    await page.waitForFunction(() => { const video = document.getElementById('live-quality-quality-late'); return video?.videoWidth > 0 && video.getVideoPlaybackQuality().totalVideoFrames > 3 && liveQualityQA.owner.peers.get('quality-late').senders.get('screen').getParameters().encodings[0]?.maxBitrate === Math.round(2200000/1.4); }, null, {timeout:20000});
    proof.latePeer = await page.evaluate(() => { const qa = liveQualityQA, video = document.getElementById('live-quality-quality-late'); return {quality:qa.owner.quality,width:video.videoWidth,height:video.videoHeight,bitrate:qa.owner.peers.get('quality-late').senders.get('screen').getParameters().encodings[0].maxBitrate,sameCapture:qa.owner.peers.get('quality-late').senders.get('screen').track === qa.originalTrack}; });
    assert.equal(proof.latePeer.sameCapture,true); assert.ok(proof.latePeer.width<=1280 && proof.latePeer.height<=720);
    phase = 'late relay peer inherits current ceiling';
    await page.evaluate(() => liveQualityQA.addPeer('quality-late-relay',true));
    await page.waitForFunction(() => { const qa=liveQualityQA, video=document.getElementById('live-quality-quality-late-relay');
      return video?.videoWidth>0 && video.getVideoPlaybackQuality().totalVideoFrames>3 &&
        qa.owner.relayMedia.sources.get('screen')?.cap===900000; }, null, {timeout:20000});
    proof.lateRelayPeer=await page.evaluate(() => {const qa=liveQualityQA,video=document.getElementById('live-quality-quality-late-relay'),source=qa.owner.relayMedia.sources.get('screen');
      return {quality:qa.owner.quality,width:video.videoWidth,height:video.videoHeight,perRecipientBitrateCap:source.cap,
        encryptedEnvelopes:qa.envelopes,sameCapture:source.track===qa.originalTrack,codec:qa.peers.get('quality-late-relay').relayMedia.peers.get(qa.owner.selfId).codec};});
    assert.equal(proof.lateRelayPeer.sameCapture,true);assert.ok(proof.lateRelayPeer.width<=1280 && proof.lateRelayPeer.height<=720);
    assert.ok(['H.264','VP8'].includes(proof.lateRelayPeer.codec));assert.equal(proof.lateRelayPeer.perRecipientBitrateCap,900000);
    phase = 'teardown'; await page.locator('#presentation-fullscreen-exit').click(); await page.evaluate(() => liveQualityQA.stop());
    assert.equal(await page.evaluate(() => liveQualityQA.originalTrack.readyState),'live'); await page.locator('#share-button').click();
    assert.equal(await page.evaluate(() => liveQualityQA.originalTrack.readyState),'ended'); await page.locator('#end-button').click();
    assert.deepEqual(errors,[]); assert.deepEqual(hashes(),proof.sourceHashes,'The quality runtime proof covers only unchanged exact source bytes');
    proof.passed=true; fs.writeFileSync(path.join(output,'live-screen-quality.json'),JSON.stringify(proof,null,2)); console.log(JSON.stringify(proof,null,2));
  } catch(error) {
    proof.phase=phase; proof.error=String(error.stack || error); proof.pageErrors=errors;
    proof.diagnostics = await page?.evaluate(() => ({selected:['quality-select','settings-quality','presentation-quality'].map(id => document.getElementById(id)?.value),
      quality:window.liveQualityQA?.owner?.quality,settings:window.liveQualityQA?.originalTrack?.getSettings(),errors:window.liveQualityQA?.errors,
      videos:[...document.querySelectorAll('video[id^="live-quality-"]')].map(video=>({id:video.id,width:video.videoWidth,height:video.videoHeight,frames:video.getVideoPlaybackQuality().totalVideoFrames}))})).catch(()=>null);
    fs.writeFileSync(path.join(output,'live-screen-quality.json'),JSON.stringify(proof,null,2)); throw error;
  } finally {
    await application?.evaluate(() => {const fixture=globalThis.liveQualityCaptureFixture;if(fixture && !fixture.isDestroyed())fixture.destroy();delete globalThis.liveQualityCaptureFixture;}).catch(()=>{});
    await application?.close(); const relative=path.relative(path.resolve(output),path.resolve(profile));
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative),'Generated test profile must stay inside test-results');
    fs.rmSync(profile,{recursive:true,force:true,maxRetries:3,retryDelay:100});
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
