'use strict';
// Two actual isolated desktop apps, production preload/native PKI WSS and a
// cold OS-format invitation. Screen pixels and microphone tones are synthetic;
// no hardware sensor, OS input or certificate exception is used.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { _electron } = require('playwright');
const root = path.resolve(__dirname, '..');
const results = path.join(root, 'test-results');
if (!process.argv.includes('--live')) throw new Error('Pass --live to use disposable public invitation rooms.');
function writeTone(file) {
  const rate = 48000, count = rate * 2, wav = Buffer.alloc(44 + count * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i++) wav.writeInt16LE(Math.round(Math.sin(i / rate * Math.PI * 880) * 8000), 44 + i * 2);
  fs.writeFileSync(file, wav);
}

async function prepare(page, forceRTC) {
  await page.evaluate(force => {
    window.qaAudioContexts = [];
    const Audio = AudioContext; window.AudioContext = new Proxy(Audio, { construct(target, args) { const context = Reflect.construct(target, args); qaAudioContexts.push(context); return context; } });
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
    const nativeMicrophone = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async config => {
      if (config.video || !config.audio) throw new Error('Only synthetic microphone input is allowed in this fixture.');
      qaCaptureCalls.push('synthetic-microphone');
      return nativeMicrophone(config);
    };
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
  await page.locator('.screen-source').filter({ hasText: 'Glance-Port' }).first().click();
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
async function receivedAudio(page) {
  await page.waitForFunction(() => [...document.querySelectorAll('audio[data-peer]')].some(audio => audio.srcObject?.getAudioTracks().some(track => track.readyState === 'live') && !audio.paused && !audio.muted), undefined, { timeout: 20000 });
  const audio = await page.evaluate(async () => {
    const element = [...document.querySelectorAll('audio[data-peer]')].find(audio => audio.srcObject?.getAudioTracks().some(track => track.readyState === 'live'));
    const context = new AudioContext(); await context.resume();
    const source = context.createMediaStreamSource(element.srcObject), analyser = context.createAnalyser(); analyser.fftSize = 2048; source.connect(analyser);
    const values = new Float32Array(analyser.fftSize); let energy = 0;
    for (let i = 0; i < 100 && energy <= .000001; i++) { await new Promise(resolve => setTimeout(resolve, 80)); analyser.getFloatTimeDomainData(values); energy = Math.max(energy, values.reduce((sum, value) => sum + value * value, 0) / values.length); }
    source.disconnect(); await context.close(); return { decodedMeanSquareEnergy: energy, paused: element.paused, muted: element.muted };
  });
  return audio;
}
async function main() {
  fs.mkdirSync(results, { recursive: true }); const apps = [], profiles = []; let phase = 'launch'; let errors = 0;
  const wav = path.join(results, 'invitation-electron-synthetic-microphone.wav'); writeTone(wav);
  const proof = { passed: false, coordinator: 'Deployed public Cloudflare Worker', nativeInputInjected: false, physicalDifferentNetworkTest: false };
  const sourceFiles=['src/main.cjs', 'src/preload.cjs', 'src/core/internet-client.cjs', 'src/renderer/app.js', 'src/renderer/rtc.js', 'src/renderer/relay-media.js'];
  const hashSource=file=>crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex');
  const sourceHashes=Object.fromEntries(sourceFiles.map(file=>[file,hashSource(file)]));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  async function launch(invitation) {
    const profile = fs.mkdtempSync(path.join(results, 'invitation-electron-profile-')); profiles.push(profile);
    const app = await _electron.launch({ args: [root, '--smoke-test', `--user-data-dir=${profile}`, '--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`, ...(invitation ? [invitation] : [])], env, timeout: 60000 }); apps.push(app);
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
    phase = 'blocked direct route finishes switching to native WSS';
    for (const page of [host, guest]) {
      await page.locator('#diagnostics-toggle').click();
      await page.waitForFunction(() => document.getElementById('rtc-stats').textContent.includes('Secure relay'), undefined, { timeout: 30000 });
      await page.locator('#diagnostics-close').click();
    }
    phase = 'explicit synthetic microphones'; for (const page of [host, guest]) await page.locator('#mic-button').click();
    phase = 'bidirectional native WSS audio'; proof.audio = { hostReceiver: await receivedAudio(host), guestReceiver: await receivedAudio(guest) };
    proof.audioProcessing = [];
    for (const page of [host, guest]) {
      await page.locator('#diagnostics-toggle').click();
      await page.waitForFunction(() => document.querySelector('#rtc-stats .stat-row'));
      proof.audioProcessing.push(await page.evaluate(() => ({ contexts: qaAudioContexts.map(context => context.state), inputMeter: document.getElementById('mic-level').value,
        measurements: [...document.querySelectorAll('#rtc-stats .stat-row')].filter(row => ['Microphone source', 'Microphone processing', 'Audio playback processing', 'Captured audio', 'Microphone level', 'Audio received', 'Audio sent'].includes(row.querySelector('span')?.textContent)).map(row => row.textContent) })));
      await page.locator('#diagnostics-close').click();
    }
    for (const audio of Object.values(proof.audio)) { assert.ok(audio.decodedMeanSquareEnergy > .000001, 'The production native WSS path must deliver non-silent microphone audio'); assert.equal(audio.paused, false); assert.equal(audio.muted, false); }
    phase = 'host screen share'; await share(host);
    phase = 'guest compressed screen receiver'; proof.guestReceiver = {}; await received(guest, 'Desktop host', proof.guestReceiver, host);
    phase = 'stop host screen'; await host.locator('#share-button').click();
    phase = 'guest screen share'; await share(guest);
    phase = 'host compressed screen receiver'; proof.hostReceiver = {}; await received(host, guestName, proof.hostReceiver, guest);
    phase = 'microphone stop and restart'; await host.locator('#mic-button').click();
    await guest.waitForFunction(() => [...document.querySelectorAll('audio[data-peer]')].every(audio => !audio.srcObject));
    await host.locator('#mic-button').click(); proof.restartedAudio = await receivedAudio(guest);
    assert.ok(proof.restartedAudio.decodedMeanSquareEnergy > .000001); assert.equal(proof.restartedAudio.paused, false); assert.equal(proof.restartedAudio.muted, false);
    assert.ok(await host.evaluate(() => qaRTC.length > 0 && qaRTC.every(pc => pc.connectionState === 'closed'))); proof.directRTCBlockedAndClosed = true;
    for (const page of [host, guest]) { assert.equal(await page.evaluate(() => qaBrowserSockets), 0); assert.ok(await page.evaluate(() => qaCaptureCalls.every(value => ['synthetic-screen', 'synthetic-microphone'].includes(value)))); }
    proof.productionNativeSocketOnly = true; proof.noSensorsCaptured = true;
    phase = 'stop and leave'; await guest.locator('#end-button').click(); await guest.waitForFunction(() => document.getElementById('session').hidden);
    await host.locator('#end-button').click(); await host.waitForFunction(() => document.getElementById('session').hidden); assert.equal(errors, 0);
    for(const file of sourceFiles) assert.equal(hashSource(file),sourceHashes[file],'Production source changed during this live test');
    proof.sourceHashes = sourceHashes;
    proof.passed = true; proof.boundary = 'Two same-PC production Electron apps and real public native WSS; synthetic 1440p screen frames and decoded microphone tones in both directions plus microphone restart, forced direct-path failure. No hardware sensors, physical Mac capture/control or different-carrier proof.';
  } catch (error) { proof.failedStage = phase; proof.failureType = error.name; proof.failureSummary = String(error.message).split('\n')[0].replace(/(?:https?:|auralink:)\/\/\S+/g, '[private invitation removed]').slice(0,200); process.exitCode = 1; }
  finally {
    for (const app of apps.reverse()) await app.close().catch(() => {});
    for (const profile of profiles) { const resolved = fs.realpathSync(profile); if (resolved.startsWith(fs.realpathSync(results) + path.sep) && path.basename(resolved).startsWith('invitation-electron-profile-')) fs.rmSync(resolved, { recursive: true, force: true }); }
    fs.writeFileSync(path.join(results, 'invitation-electron-live.json'), JSON.stringify(proof, null, 2)); console.log(JSON.stringify(proof, null, 2));
  }
}
main().catch(() => { console.error('Live desktop screen verification did not complete. Private invitation details withheld.'); process.exitCode = 1; });
