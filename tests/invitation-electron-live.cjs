'use strict';
// Two actual isolated desktop apps, production preload/native PKI WSS and a
// cold OS-format invitation. Only synthetic screen pixels are captured; no
// microphone, camera, OS input or certificate exception is used.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { _electron } = require('playwright');
const root = path.resolve(__dirname, '..');
const results = path.join(root, 'test-results');
if (!process.argv.includes('--live')) throw new Error('Pass --live to use disposable public invitation rooms.');

async function prepare(page, forceRTC) {
  await page.evaluate(force => {
    window.qaRTC = []; window.qaBrowserSockets = 0; window.qaCaptureCalls = [];
    window.qaSourcePaints = 0; window.qaEncodes = 0; window.qaEncoded = 0; window.qaCodecFailures = 0;
    const Encoder = VideoEncoder; window.VideoEncoder = new Proxy(Encoder, { construct(target, args) {
      const callbacks = args[0]; const encoder = Reflect.construct(target, [{ ...callbacks, output: (...values) => { qaEncoded++; return callbacks.output(...values); }, error: (...values) => { qaCodecFailures++; return callbacks.error(...values); } }]);
      const encode = encoder.encode.bind(encoder); encoder.encode = (...values) => { qaEncodes++; return encode(...values); }; return encoder;
    } });
    const Socket = WebSocket; window.WebSocket = new Proxy(Socket, { construct(target, args) { qaBrowserSockets++; return Reflect.construct(target, args); } });
    const RTC = RTCPeerConnection; window.RTCPeerConnection = new Proxy(RTC, { construct(target, args) {
      const pc = Reflect.construct(target, force ? [{ ...args[0], iceServers: [], iceTransportPolicy: 'relay' }] : args); qaRTC.push(pc); return pc;
    } });
    navigator.mediaDevices.getUserMedia = async () => { qaCaptureCalls.push('sensor'); throw new Error('Hardware sensor capture is outside this screen-only fixture.'); };
    navigator.mediaDevices.getDisplayMedia = async () => {
      qaCaptureCalls.push('synthetic-screen'); const canvas = document.createElement('canvas'); canvas.width = 2560; canvas.height = 1440;
      const ctx = canvas.getContext('2d'); let count = 0;
      const timer = setInterval(() => { qaSourcePaints++; ctx.fillStyle = '#102235'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#6ce9cb'; ctx.fillRect((count++ * 25) % 2100, 200, 400, 200); ctx.fillStyle = '#fff'; ctx.font = '48px sans-serif'; ctx.fillText('Synthetic desktop screen ' + count, 60, 80);
      }, 1000 / 30);
      const stream = canvas.captureStream(30), track=stream.getVideoTracks()[0], stop=track.stop.bind(track);
      track.stop=()=>{clearInterval(timer);stop();}; track.addEventListener('ended', () => clearInterval(timer)); return stream;
    };
  }, forceRTC);
}
async function share(page) {
  await page.locator('#diagnostics-toggle').click(); await page.locator('#quality-select').selectOption('1440'); await page.locator('#diagnostics-close').click(); await page.locator('#share-button').click();
  await page.locator('.screen-source').filter({ hasText: 'Auralink' }).first().click();
}
async function received(page, name, proof, sender) {
  await page.getByRole('button', { name: `View ${name}`, exact: true }).click();
  await page.waitForFunction(() => { const video = document.getElementById('stage-video'); return !video.hidden && video.videoWidth === 2560 && video.videoHeight === 1440; }, undefined, { timeout: 35000 });
  const beforeSource=await sender.evaluate(()=>({paints:qaSourcePaints,encodes:qaEncodes,encoded:qaEncoded,failures:qaCodecFailures}));
  const frames = await page.locator('#stage-video').evaluate(async video => {
    const start = video.getVideoPlaybackQuality().totalVideoFrames, time = performance.now();
    await new Promise(resolve => setTimeout(resolve, 3000));
    return { width: video.videoWidth, height: video.videoHeight, frames: video.getVideoPlaybackQuality().totalVideoFrames - start, fps: (video.getVideoPlaybackQuality().totalVideoFrames - start) * 1000 / (performance.now() - time) };
  });
  proof.measurement = frames;
  const afterSource=await sender.evaluate(()=>({paints:qaSourcePaints,encodes:qaEncodes,encoded:qaEncoded,failures:qaCodecFailures}));
  proof.source=Object.fromEntries(Object.keys(afterSource).map(key=>[key,afterSource[key]-beforeSource[key]]));
  await page.locator('#diagnostics-toggle').click(); await page.waitForFunction(() => document.getElementById('diagnostics').textContent.includes('Secure relay'));
  const diagnostic = await page.locator('#diagnostics').innerText(); assert.match(diagnostic, /H\.264|VP8/i); proof.codec = /H\.264/i.test(diagnostic) ? 'H.264' : 'VP8'; await page.locator('#diagnostics-close').click();
  assert.ok(frames.fps > 15, 'The compressed relay must display more than 15 actual frames per second');
  return frames;
}
async function main() {
  fs.mkdirSync(results, { recursive: true }); const apps = [], profiles = []; let phase = 'launch'; let errors = 0;
  const proof = { passed: false, coordinator: 'Deployed public Cloudflare Worker', nativeInputInjected: false, physicalDifferentNetworkTest: false };
  const sourceFiles=['src/main.cjs', 'src/preload.cjs', 'src/core/internet-client.cjs', 'src/renderer/app.js', 'src/renderer/rtc.js', 'src/renderer/relay-media.js'];
  const hashSource=file=>crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex');
  const sourceHashes=Object.fromEntries(sourceFiles.map(file=>[file,hashSource(file)]));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  async function launch(invitation) {
    const profile = fs.mkdtempSync(path.join(results, 'invitation-electron-profile-')); profiles.push(profile);
    const app = await _electron.launch({ args: [root, '--smoke-test', `--user-data-dir=${profile}`, '--autoplay-policy=no-user-gesture-required', ...(invitation ? [invitation] : [])], env, timeout: 60000 }); apps.push(app);
    const page = await app.firstWindow(); page.on('pageerror', () => errors++); await page.locator('#host-button').waitFor(); return page;
  }
  try {
    const host = await launch(); await prepare(host, true); await host.locator('#quick-name').fill('Desktop host');
    phase = 'one-click public room'; await host.locator('#host-button').click(); await host.waitForFunction(() => !document.getElementById('share-button').disabled);
    const code = await host.locator('#room-code').inputValue(); assert.match(code, /^A1\.[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/);
    phase = 'cold joining link'; const guest = await launch(`auralink://join#code=${code}`); await prepare(guest, false);
    await guest.waitForFunction(() => !document.getElementById('share-button').disabled); assert.equal(await host.locator('#pending-banner').isVisible(), false);
    const guestName = (await guest.locator('#display-name').inputValue()) || 'My device';
    assert.deepEqual(await host.evaluate(() => qaCaptureCalls), []); assert.deepEqual(await guest.evaluate(() => qaCaptureCalls), []);
    proof.oneClickCreationAndColdLinkAutoAdmission = true;
    phase = 'host screen share'; await share(host);
    phase = 'guest compressed screen receiver'; proof.guestReceiver = {}; await received(guest, 'Desktop host', proof.guestReceiver, host);
    phase = 'stop host screen'; await host.locator('#share-button').click();
    phase = 'guest screen share'; await share(guest);
    phase = 'host compressed screen receiver'; proof.hostReceiver = {}; await received(host, guestName, proof.hostReceiver, guest);
    assert.ok(await host.evaluate(() => qaRTC.length > 0 && qaRTC.every(pc => pc.connectionState === 'closed'))); proof.directRTCBlockedAndClosed = true;
    for (const page of [host, guest]) { assert.equal(await page.evaluate(() => qaBrowserSockets), 0); assert.ok(await page.evaluate(() => qaCaptureCalls.every(value => value === 'synthetic-screen'))); }
    proof.productionNativeSocketOnly = true; proof.noSensorsCaptured = true;
    phase = 'stop and leave'; await guest.locator('#end-button').click(); await guest.waitForFunction(() => document.getElementById('session').hidden);
    await host.locator('#end-button').click(); await host.waitForFunction(() => document.getElementById('session').hidden); assert.equal(errors, 0);
    for(const file of sourceFiles) assert.equal(hashSource(file),sourceHashes[file],'Production source changed during this live test');
    proof.sourceHashes = sourceHashes;
    proof.passed = true; proof.boundary = 'Two same-PC production Electron apps and real public native WSS; synthetic 1440p screen frames, forced direct-path failure. No physical Mac capture/control or different-carrier proof.';
  } catch (error) { proof.failedStage = phase; proof.failureType = error.name; proof.failureSummary = String(error.message).split('\n')[0].replace(/(?:https?:|auralink:)\/\/\S+/g, '[private invitation removed]').slice(0,200); process.exitCode = 1; }
  finally {
    for (const app of apps.reverse()) await app.close().catch(() => {});
    for (const profile of profiles) { const resolved = fs.realpathSync(profile); if (resolved.startsWith(fs.realpathSync(results) + path.sep) && path.basename(resolved).startsWith('invitation-electron-profile-')) fs.rmSync(resolved, { recursive: true, force: true }); }
    fs.writeFileSync(path.join(results, 'invitation-electron-live.json'), JSON.stringify(proof, null, 2)); console.log(JSON.stringify(proof, null, 2));
  }
}
main().catch(() => { console.error('Live desktop screen verification did not complete. Private invitation details withheld.'); process.exitCode = 1; });
