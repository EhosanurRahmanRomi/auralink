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
    window.qaMicrophoneRequests = []; window.qaMicrophoneStreams = []; window.qaNotices = [];
    window.qaSafeErrorName = name => ['NotAllowedError', 'PermissionDeniedError', 'NotReadableError', 'TrackStartError', 'NotFoundError', 'OverconstrainedError', 'AbortError', 'NotSupportedError', 'InvalidStateError', 'SecurityError', 'TypeError', 'Error'].includes(name) ? name : 'OtherError';
    window.qaSafeAudioText = text => {
      const safe = [
        'Your microphone is off', 'Microphone unavailable · check sound', 'Microphone paused by your device',
        'Microphone disconnected. Turn it on to retry.', 'Tap Test microphone, then speak.',
        'Input detected. Your microphone is working.', 'Listening… speak into your microphone.', 'Microphone test stopped.',
        'Microphone processing needs a tap', 'Room audio needs a tap',
        'Resume audio processing so the other person can hear your microphone.', 'Enable playback to hear the other participants.',
        'Playback is still blocked. Check your device sound permission, then tap Enable sound again.',
        'Allow microphone access in your device privacy settings, then try again. Windows: Settings → Privacy & security → Microphone, including desktop apps.',
        'Allow Glance-Port in System Settings → Privacy & Security → Microphone, then quit and reopen the app if macOS requests it.',
        'Your microphone could not start. Close another app using it, check the device connection, or select System default in Preferences.',
        'No microphone was found. Connect one and check the selected device in Preferences.',
        'Incoming relay audio could not start. Open Check sound and enable sound, or rejoin the room.',
        'Relay microphone processing could not start. Check microphone permission, then turn the microphone off and on again.'
      ];
      if (safe.includes(text)) return text;
      if (text?.startsWith('Microphone: ')) return safe.includes(text.slice(12)) ? text : 'Microphone error: text omitted.';
      if (text?.endsWith(' · input detected')) return 'Microphone input detected: device label omitted.';
      if (text?.endsWith(' · listening')) return 'Microphone listening: device label omitted.';
      return text ? 'Other text omitted.' : '';
    };
    const notices = document.getElementById('toast-region');
    if (notices) {
      new MutationObserver(records => {
        for (const record of records) for (const node of record.addedNodes) if (node.nodeType === 1 && node.classList.contains('toast')) {
          qaNotices.push({ error: node.classList.contains('error'), text: qaSafeAudioText(node.textContent) });
          if (qaNotices.length > 20) qaNotices.shift();
        }
      }).observe(notices, { childList: true });
    }
    window.qaNativeSocketEvents = { open: 0, message: 0, error: 0, closes: [] };
    window.glancePort?.onInternetEvent?.(event => {
      if (['open', 'message', 'error'].includes(event?.type)) qaNativeSocketEvents[event.type]++;
      else if (event?.type === 'close') {
        qaNativeSocketEvents.closes.push({ code: Number.isInteger(event.code) ? event.code : null,
          reason: event.reason === 'Public connection limit reached. Try again later.' ? 'Public connection limit reached. Try again later.' : event.reason === 'Coordinator unavailable. Reconnect.' ? 'Coordinator unavailable. Reconnect.' : 'Close reason omitted.' });
        if (qaNativeSocketEvents.closes.length > 10) qaNativeSocketEvents.closes.shift();
      }
    });
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
      const audio = typeof config.audio === 'object' ? config.audio : {};
      // Chromium's file-input fixture recommends disabling processing for the
      // prerecorded tone. Keep native capture and production permission IPC;
      // this explicit test override does not validate default mic processing.
      // https://chromium.googlesource.com/chromium/src/+/HEAD/media/base/media_switches.cc
      const fixtureAudio = { ...audio, echoCancellation: { exact: false }, noiseSuppression: { exact: false }, autoGainControl: { exact: false } };
      const request = { completed: false, errorName: null,
        productionRequestedProcessing: Object.fromEntries(['echoCancellation', 'noiseSuppression', 'autoGainControl'].map(key => [key, typeof audio[key] === 'boolean' ? audio[key] : null])),
        fixtureRequestedProcessing: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } };
      qaMicrophoneRequests.push(request);
      try {
        const stream = await nativeMicrophone({ ...config, audio: fixtureAudio }); request.completed = true;
        request.actualProcessing = stream.getAudioTracks().map(track => {
          const settings = track.getSettings();
          return Object.fromEntries(['echoCancellation', 'noiseSuppression', 'autoGainControl'].map(key => [key, typeof settings[key] === 'boolean' ? settings[key] : null]));
        });
        qaMicrophoneStreams.push(stream); return stream;
      } catch (error) { request.errorName = qaSafeErrorName(error?.name); throw error; }
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

async function audioFailureDiagnosis(page) {
  if (page.isClosed()) return { unavailable: 'Application window closed.' };
  return page.evaluate(async () => {
    const safeText = window.qaSafeAudioText || (() => 'Audio instrumentation not installed.');
    const enumValue = (value, choices) => choices.includes(value) ? value : null;
    const number = value => Number.isFinite(value) ? value : null;
    const trackState = track => {
      const settings = track.getSettings();
      return { readyState: enumValue(track.readyState, ['live', 'ended']), enabled: track.enabled, muted: track.muted,
        sampleRate: number(settings.sampleRate), channelCount: number(settings.channelCount),
        processing: Object.fromEntries(['echoCancellation', 'noiseSuppression', 'autoGainControl'].map(key => [key, typeof settings[key] === 'boolean' ? settings[key] : null])) };
    };
    const label = (id, choices) => enumValue(document.getElementById(id)?.getAttribute('aria-label'), choices);
    let permissions = null;
    try {
      const info = await window.glancePort?.getInfo?.();
      if (info?.permissions) permissions = Object.fromEntries(['microphone', 'screen', 'accessibility'].map(key => [key, enumValue(info.permissions[key], ['granted', 'denied', 'restricted', 'not-determined', 'not-required', 'unknown'])]));
    } catch { permissions = { unavailable: 'Permission status read failed.' }; }
    return {
      joinedRoomVisible: document.getElementById('session')?.hidden === false,
      micEnabled: document.getElementById('mic-button')?.classList.contains('enabled') === true,
      micDisabled: document.getElementById('mic-button')?.disabled === true,
      micLabel: label('mic-button', ['Turn microphone on', 'Turn microphone off']),
      presentationMicLabel: label('presentation-mic-button', ['Turn microphone on', 'Turn microphone off']),
      microphoneStatus: safeText(document.getElementById('voice-status-text')?.textContent),
      microphoneStatusError: document.getElementById('voice-status')?.classList.contains('error') === true,
      microphoneMeter: number(document.getElementById('mic-level')?.value),
      microphoneTestStatus: safeText(document.getElementById('mic-test-status')?.textContent),
      audioBannerVisible: document.getElementById('audio-banner')?.hidden === false,
      audioBannerTitle: safeText(document.getElementById('audio-banner-title')?.textContent),
      audioBannerText: safeText(document.getElementById('audio-banner-text')?.textContent),
      permissions,
      audioMeasurements: [...document.querySelectorAll('#rtc-stats .stat-row')].filter(row => ['Audio received', 'Audio sent', 'Microphone level', 'Microphone source', 'Microphone processing', 'Audio playback processing', 'Captured audio', 'Playback'].includes(row.querySelector('span')?.textContent)).map(row => {
        const label = row.querySelector('span').textContent, value = row.querySelector('strong')?.textContent;
        const safe = ['—', 'off', 'live', 'ended', 'paused', 'running', 'suspended', 'interrupted', 'closed', 'Enabled', 'No remote microphone', 'Tap Enable sound'];
        return { label, value: safe.includes(value) || /^(?:[0-9]{1,12} (?:packets|blocks)|[0-9]{1,3}%)$/.test(value || '') ? value : 'Measurement value omitted.' };
      }),
      contexts: (window.qaAudioContexts || []).slice(-20).map(context => ({ state: enumValue(context.state, ['running', 'suspended', 'interrupted', 'closed']), sampleRate: number(context.sampleRate) })),
      captureCalls: (window.qaCaptureCalls || []).filter(value => ['synthetic-microphone', 'synthetic-screen'].includes(value)).slice(-20),
      microphoneRequests: (window.qaMicrophoneRequests || []).slice(-10),
      microphoneTracks: (window.qaMicrophoneStreams || []).slice(-10).flatMap(stream => stream.getAudioTracks().map(trackState)),
      receivedAudio: [...document.querySelectorAll('audio[data-peer]')].map(audio => ({ hasStream: Boolean(audio.srcObject),
        paused: audio.paused, muted: audio.muted, volume: audio.volume, readyState: audio.readyState, currentTime: number(audio.currentTime),
        playbackBlocked: audio.dataset.blocked === 'true', tracks: audio.srcObject?.getAudioTracks().map(trackState) || [] })),
      rtcStates: (window.qaRTC || []).slice(-10).map(pc => ({ connection: enumValue(pc.connectionState, ['new', 'connecting', 'connected', 'disconnected', 'failed', 'closed']),
        ice: enumValue(pc.iceConnectionState, ['new', 'checking', 'connected', 'completed', 'disconnected', 'failed', 'closed']),
        signaling: enumValue(pc.signalingState, ['stable', 'have-local-offer', 'have-remote-offer', 'have-local-pranswer', 'have-remote-pranswer', 'closed']),
        senderAudioTracks: pc.getSenders().filter(sender => sender.track?.kind === 'audio').map(sender => trackState(sender.track)),
        receiverAudioTracks: pc.getReceivers().filter(receiver => receiver.track?.kind === 'audio').map(receiver => trackState(receiver.track)) })),
      browserSocketsCreated: number(window.qaBrowserSockets), nativeSocketEvents: window.qaNativeSocketEvents || null,
      notices: window.qaNotices || []
    };
  }).catch(() => ({ unavailable: 'Audio state snapshot failed.' }));
}
async function installNativePermissionFixture(app, expectedWav) {
  return app.evaluate(({ app, systemPreferences }, expectedFile) => {
    const original = systemPreferences.getMediaAccessStatus;
    const observed = original.call(systemPreferences, 'microphone');
    const originalStatus = ['granted', 'denied', 'restricted', 'not-determined', 'unknown'].includes(observed) ? observed : 'unknown';
    const githubActions = process.env.GITHUB_ACTIONS === 'true';
    const smokeTestProcess = app.commandLine.hasSwitch('smoke-test'), unpackagedProcess = app.isPackaged === false;
    const fakeInputProcess = app.commandLine.hasSwitch('use-fake-device-for-media-stream') && app.commandLine.hasSwitch('use-fake-ui-for-media-stream') && app.commandLine.getSwitchValue('use-file-for-fake-audio-capture') === expectedFile;
    const overrideApplied = githubActions && originalStatus === 'denied';
    if (overrideApplied && (!smokeTestProcess || !unpackagedProcess || !fakeInputProcess)) throw new Error('Permission fixture requires the isolated unpackaged native fake-input test process.');
    const proof = { mode: overrideApplied ? 'CI native microphone permission double' : 'Actual native microphone policy; no override',
      originalStatus, effectiveStatus: overrideApplied ? 'granted' : originalStatus,
      githubActions, smokeTestProcess, unpackagedProcess, fakeInputProcess, overrideApplied, nativeMicrophoneStatusCalls: 0,
      originalRestored: !overrideApplied, physicalPolicyVerified: false,
      boundary: 'CI-only in-process microphone permission-status double for synthetic capture; actual Windows privacy policy and physical microphone permission are not verified.' };
    if (globalThis.__qaGlancePortNativePermissionFixture) throw new Error('Native permission fixture was already installed.');
    const state = { original, proof };
    if (overrideApplied) {
      state.replacement = type => {
        if (type === 'microphone') { proof.nativeMicrophoneStatusCalls++; return 'granted'; }
        return original.call(systemPreferences, type);
      };
      systemPreferences.getMediaAccessStatus = state.replacement;
      if (systemPreferences.getMediaAccessStatus !== state.replacement) throw new Error('Native permission fixture could not be installed.');
    }
    globalThis.__qaGlancePortNativePermissionFixture = state;
    return { ...proof };
  }, expectedWav);
}
async function restoreNativePermissionFixture(app) {
  return app.evaluate(({ systemPreferences }) => {
    const state = globalThis.__qaGlancePortNativePermissionFixture;
    if (!state) return null;
    if (state.proof.overrideApplied) {
      if (systemPreferences.getMediaAccessStatus !== state.replacement) throw new Error('Native permission fixture changed unexpectedly.');
      systemPreferences.getMediaAccessStatus = state.original;
      state.proof.originalRestored = systemPreferences.getMediaAccessStatus === state.original;
    }
    const proof = { ...state.proof }; delete globalThis.__qaGlancePortNativePermissionFixture; return proof;
  });
}
async function main() {
  fs.mkdirSync(results, { recursive: true }); const apps = [], profiles = [], windows = []; let phase = 'launch'; let errors = 0;
  const wav = path.join(results, 'invitation-electron-synthetic-microphone.wav'); writeTone(wav);
  const proof = { passed: false, coordinator: 'Deployed public Cloudflare Worker', nativeInputInjected: false, physicalDifferentNetworkTest: false };
  proof.microphoneFixture = {
    source: 'Looping synthetic WAV through native getUserMedia fake device', sampleRate: 48000, channels: 1, frequencyHz: 440,
    processing: 'Fixture-only raw input constraints disable echo cancellation, noise suppression and automatic gain control; production requestMedia preflight, native capture and real relay worklets remain active.',
    outputDevice: 'Chromium fake final OS output stream; normal browser audio mixer and clock remain active.',
    productionDefaultProcessingVerified: false, physicalMicrophoneVerified: false, physicalSpeakerVerified: false, generatedOscillatorUsed: false
  };
  const sourceFiles=['src/main.cjs', 'src/preload.cjs', 'src/core/internet-client.cjs', 'src/renderer/app.js', 'src/renderer/rtc.js', 'src/renderer/relay-media.js', 'src/renderer/audio-mixer.js', 'src/renderer/audio-worklet.js', 'src/renderer/screen-view.js'];
  const hashSource=file=>crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex');
  const sourceHashes=Object.fromEntries(sourceFiles.map(file=>[file,hashSource(file)]));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  async function launch(invitation) {
    const profile = fs.mkdtempSync(path.join(results, 'invitation-electron-profile-')); profiles.push(profile);
    // Replace only the final OS sink so a CI VM does not need audio hardware.
    // https://chromium.googlesource.com/chromium/src/+/HEAD/media/audio/audio_manager_base.cc
    const app = await _electron.launch({ args: [root, '--smoke-test', `--user-data-dir=${profile}`, '--autoplay-policy=no-user-gesture-required', '--disable-audio-output', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`, ...(invitation ? [invitation] : [])], env, timeout: 60000 }); apps.push(app);
    const page = await app.firstWindow(); const windowProof = { page, app, role: invitation ? 'guest' : 'host', pageErrors: 0 };
    windows.push(windowProof); page.on('pageerror', () => { errors++; windowProof.pageErrors++; }); await page.locator('#host-button').waitFor();
    windowProof.fixtureCommandLine = await app.evaluate(({ app }, expectedWav) => ({
      fakeDevice: app.commandLine.hasSwitch('use-fake-device-for-media-stream'), fakeUi: app.commandLine.hasSwitch('use-fake-ui-for-media-stream'),
      fakeAudioFileMatchesExpected: app.commandLine.getSwitchValue('use-file-for-fake-audio-capture') === expectedWav,
      fakeFinalOutput: app.commandLine.hasSwitch('disable-audio-output')
    }), wav);
    assert.ok(Object.values(windowProof.fixtureCommandLine).every(Boolean), 'Native test process must contain every declared audio fixture switch');
    return page;
  }
  try {
    const host = await launch(); await prepare(host, true); await host.locator('#quick-name').fill('Desktop host');
    phase = 'one-click public room'; await host.locator('#host-button').click(); await host.waitForFunction(() => !document.getElementById('share-button').disabled);
    const code = await host.locator('#room-code').inputValue(); assert.match(code, /^A1\.[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/);
    phase = 'cold joining link'; const guest = await launch(`glance-port://join#code=${code}`); await prepare(guest, false);
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
    phase = 'declared native microphone permission fixture'; proof.nativePermissionFixture = [];
    for (const windowProof of windows) {
      windowProof.nativePermissionFixture = await installNativePermissionFixture(windowProof.app, wav);
      proof.nativePermissionFixture.push({ role: windowProof.role, ...windowProof.nativePermissionFixture });
    }
    phase = 'explicit synthetic microphones'; for (const page of [host, guest]) await page.locator('#mic-button').click();
    proof.audio = {}; phase = 'host receives guest native WSS audio'; proof.audio.hostReceiver = await receivedAudio(host);
    phase = 'guest receives host native WSS audio'; proof.audio.guestReceiver = await receivedAudio(guest);
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
    proof.fixtureCommandLines = windows.map(({ role, fixtureCommandLine }) => ({ role, ...fixtureCommandLine }));
    proof.microphoneRequests = await Promise.all(windows.map(async ({ role, page }) => ({ role, requests: await page.evaluate(() => qaMicrophoneRequests) })));
    for (const { requests } of proof.microphoneRequests) {
      assert.ok(requests.length > 0, 'Each actual app must complete native fake microphone capture');
      for (const request of requests) {
        assert.equal(request.completed, true); assert.equal(request.errorName, null);
        for (const key of ['echoCancellation', 'noiseSuppression', 'autoGainControl']) {
          assert.equal(request.productionRequestedProcessing[key], true, 'Production microphone processing request must remain unchanged');
          assert.equal(request.fixtureRequestedProcessing[key], false);
        }
        assert.ok(request.actualProcessing.length > 0, 'Native microphone must report actual audio track processing settings');
        for (const settings of request.actualProcessing) for (const key of ['echoCancellation', 'noiseSuppression', 'autoGainControl']) assert.equal(settings[key], false, 'The native prerecorded WAV fixture must honor raw processing settings');
      }
    }
    proof.nativePermissionFixture = await Promise.all(windows.map(async ({ role, app }) => ({ role, ...await restoreNativePermissionFixture(app) })));
    for (const fixture of proof.nativePermissionFixture) {
      assert.equal(fixture.originalRestored, true); assert.equal(fixture.physicalPolicyVerified, false);
      if (fixture.overrideApplied) {
        assert.equal(fixture.mode, 'CI native microphone permission double'); assert.equal(fixture.githubActions, true);
        assert.equal(fixture.originalStatus, 'denied'); assert.equal(fixture.effectiveStatus, 'granted');
        assert.ok(fixture.smokeTestProcess && fixture.unpackagedProcess && fixture.fakeInputProcess);
        assert.ok(fixture.nativeMicrophoneStatusCalls > 0, 'Production requestMedia must actually read the virtual CI microphone permission status');
      }
    }
    proof.passed = true; proof.boundary = 'Two same-PC production Electron apps and real public native WSS; synthetic 1440p screens and looping WAV microphones through native fake getUserMedia with fixture-only raw processing, real relay worklets and a Chromium fake final OS output stream. A denied native microphone status may use a declared CI-only process permission double; production requestMedia IPC still executes, and real OS privacy policy is not verified. Strict decoded audio energy in both directions and microphone restart, forced direct-path failure. No production default audio processing, hardware microphone/speaker, physical Mac capture/control or different-carrier proof.';
  } catch (error) {
    proof.failedStage = phase; proof.failureType = ['TimeoutError', 'AssertionError', 'TypeError', 'Error'].includes(error.name) ? error.name : 'OtherError';
    proof.failureSummary = error.name === 'TimeoutError' ? 'A required live media or interface condition did not complete within its unchanged timeout.' : 'A required live runtime assertion failed; exception text omitted.';
    proof.failureDiagnostics = await Promise.all(windows.map(async ({ page, app, role, pageErrors }) => ({ role, pageErrors,
      renderer: await audioFailureDiagnosis(page),
      native: await app.evaluate(({ app, BrowserWindow }, expectedWav) => ({
        platform: process.platform, windowCount: BrowserWindow.getAllWindows().length,
        fakeDevice: app.commandLine.hasSwitch('use-fake-device-for-media-stream'), fakeUi: app.commandLine.hasSwitch('use-fake-ui-for-media-stream'),
        fakeAudioFile: app.commandLine.hasSwitch('use-file-for-fake-audio-capture'),
        fakeAudioFileMatchesExpected: app.commandLine.getSwitchValue('use-file-for-fake-audio-capture') === expectedWav,
        fakeFinalOutput: app.commandLine.hasSwitch('disable-audio-output')
      }), wav).catch(() => ({ unavailable: 'Native state snapshot failed.' }))
    })));
    process.exitCode = 1;
  }
  finally {
    for (const { app, role } of windows) {
      const fixture = await restoreNativePermissionFixture(app).catch(() => ({ originalRestored: false, restorationError: 'Native permission fixture restoration failed.' }));
      if (fixture) {
        const entry = { role, ...fixture }, index = proof.nativePermissionFixture?.findIndex(value => value.role === role) ?? -1;
        if (!proof.nativePermissionFixture) proof.nativePermissionFixture = [];
        if (index >= 0) proof.nativePermissionFixture[index] = entry; else proof.nativePermissionFixture.push(entry);
        if (!fixture.originalRestored) { proof.passed = false; process.exitCode = 1; }
      }
    }
    for (const app of apps.reverse()) await app.close().catch(() => {});
    for (const profile of profiles) { const resolved = fs.realpathSync(profile); if (resolved.startsWith(fs.realpathSync(results) + path.sep) && path.basename(resolved).startsWith('invitation-electron-profile-')) fs.rmSync(resolved, { recursive: true, force: true }); }
    fs.writeFileSync(path.join(results, 'invitation-electron-live.json'), JSON.stringify(proof, null, 2)); console.log(JSON.stringify(proof, null, 2));
  }
}
main().catch(() => { console.error('Live desktop screen verification did not complete. Private invitation details withheld.'); process.exitCode = 1; });
