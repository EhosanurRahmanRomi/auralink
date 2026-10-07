'use strict';

// Explicit opt-in: two independent, actual production Electron apps use their
// bundled renderer/preload/native WSS against the private public coordinator.
// Chromium supplies synthetic camera/WAV microphone data; no OS input, screen
// capture, hardware microphone/camera, or certificate exception is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { _electron } = require('playwright');
const WebSocket = require('ws');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'test-results');
const origin = process.env.AURALINK_PUBLIC_ORIGIN || 'https://auralink-private-coordinator.auralink-internet-service.workers.dev';
const secretFile = process.env.AURALINK_SECRETS_FILE || path.join(root, '.private/internet-secrets.json');
const diagnosticPermissions = process.env.AURALINK_QA_INTERNET_NETWORK_PERMISSION === '1';
if (process.env.AURALINK_PUBLIC_ELECTRON_MEDIA_TEST !== '1') throw new Error('Opt in with AURALINK_PUBLIC_ELECTRON_MEDIA_TEST=1. The test pairs two temporary QA devices with the configured public service.');

function writeTone(file) {
  const sampleRate = 48000, count = sampleRate * 2, wav = Buffer.alloc(44 + count * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(count * 2, 40);
  for (let index = 0; index < count; index++) wav.writeInt16LE(Math.round(Math.sin(index / sampleRate * Math.PI * 880) * 9000), 44 + index * 2);
  fs.writeFileSync(file, wav);
}
async function poll(check, timeout = 30000) {
  const deadline = Date.now() + timeout;
  do { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 150)); } while (Date.now() < deadline);
  throw new Error('The expected media condition was not observed before its deadline.');
}
async function snapshot(page) {
  return page.evaluate(async () => {
    const results = [];
    for (const pc of qaRTCs) {
      const report = await pc.getStats(); const values = [...report.values()];
      const inbound = values.filter(row => row.type === 'inbound-rtp').map(row => ({ kind: row.kind, packetsReceived: row.packetsReceived, framesDecoded: row.framesDecoded,
        width: row.frameWidth, height: row.frameHeight, totalAudioEnergy: row.totalAudioEnergy, samplesDuration: row.totalSamplesDuration,
        muted: pc.getReceivers().find(receiver => receiver.track.id === row.trackIdentifier)?.track.muted }));
      const transport = values.find(row => row.type === 'transport' && row.selectedCandidatePairId);
      const pair = transport ? report.get(transport.selectedCandidatePairId) : values.find(row => row.type === 'candidate-pair' && row.state === 'succeeded' && row.nominated);
      const candidate = pair && report.get(pair.localCandidateId);
      results.push({ connection: pc.connectionState, ice: pc.iceConnectionState, signaling: pc.signalingState, inbound,
        route: candidate ? { candidateType: candidate.candidateType, protocol: candidate.protocol } : null });
    }
    const video = document.getElementById('stage-video');
    return { rtc: results, stage: { hidden: video.hidden, width: video.videoWidth, height: video.videoHeight, time: video.currentTime, paused: video.paused },
      audioOutputs: [...document.querySelectorAll('audio[data-peer]')].map(audio => ({ active: Boolean(audio.srcObject), paused: audio.paused, muted: audio.muted })),
      captureCalls: qaCaptureCalls, captureTracks: qaStreams.flatMap(stream => stream.getTracks().map(track => ({ kind: track.kind, readyState: track.readyState }))),
      candidateTypes: qaCandidates, browserSocketConstructions: qaBrowserSocketConstructions, pageErrors: qaPageErrors,
      connectionLabel: document.getElementById('connection-pill').textContent, soundUnlockVisible: !document.getElementById('audio-banner').hidden };
  });
}
async function mediaProof(page, name, previousEnergy = 0) {
  await page.getByRole('button', { name: `View ${name}`, exact: true }).click();
  return poll(async () => {
    const proof = await snapshot(page); const inbound = proof.rtc.flatMap(pc => pc.inbound);
    return proof.rtc.some(pc => pc.connection === 'connected') && !proof.stage.hidden && proof.stage.width > 0 && proof.stage.time > 0 &&
      inbound.some(row => row.kind === 'video' && row.framesDecoded > 2 && row.muted === false) &&
      inbound.some(row => row.kind === 'audio' && row.totalAudioEnergy > previousEnergy + .00001 && row.muted === false) &&
      proof.audioOutputs.some(audio => audio.active && !audio.paused && !audio.muted) ? proof : false;
  });
}
async function pair(page, name, pairingKey) {
  await page.locator('#internet-settings-button').click(); await page.locator('#display-name').fill(name); await page.locator('#save-settings').click();
  await page.locator('#internet-service').fill(origin); await page.locator('#internet-pairing-code').fill(pairingKey); await page.locator('#internet-go-online').click();
  await page.waitForFunction(() => document.getElementById('internet-status').textContent === 'Online', null, { timeout: 20000 });
  assert.equal(await page.locator('#internet-pairing-code').inputValue(), '');
  assert.equal(await page.evaluate(key => Object.values(localStorage).some(value => value.includes(key)), pairingKey), false);
}
async function forgetIdentity(identity) {
  if (!identity) return;
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(origin.replace(/^https:/, 'wss:') + '/internet/ws'); let finished = false;
    const finish = error => { if (finished) return; finished = true; clearTimeout(timer); socket.close(); error ? reject(error) : resolve(); };
    const timer = setTimeout(() => { socket.terminate(); finish(new Error('QA device removal was not confirmed.')); }, 15000);
    socket.once('open', () => socket.send(JSON.stringify({ type: 'register', ...identity, name: 'Electron media QA cleanup' })));
    socket.on('message', raw => { const packet = JSON.parse(raw.toString()); if (packet.type === 'registered') socket.send(JSON.stringify({ type: 'forget' })); else if (packet.type === 'forgotten' && packet.deviceId === identity.deviceId) finish(); else if (packet.type === 'error') finish(new Error('QA device cleanup was rejected.')); });
    socket.once('error', () => finish(new Error('QA device cleanup could not connect.')));
  });
}
async function main() {
  fs.mkdirSync(output, { recursive: true });
  const pairingKey = JSON.parse(fs.readFileSync(secretFile, 'utf8')).PAIRING_KEY;
  if (typeof pairingKey !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(pairingKey)) throw new Error('The ignored private file does not contain a valid pairing key.');
  const address = new URL(origin); if (address.protocol !== 'https:' || address.pathname !== '/' || address.username || address.password || address.search || address.hash) throw new Error('A clean public HTTPS coordinator origin is required.');
  const nameSuffix = Date.now().toString(36); const names = [`Electron owner ${nameSuffix}`, `Electron guest ${nameSuffix}`];
  const workspace = fs.mkdtempSync(path.join(output, 'internet-electron-media-')); const wav = path.join(workspace, 'synthetic-microphone.wav'); writeTone(wav);
  const clients = []; let phase = 'launch';
  const proof = { passed: false, origin, scope: 'Two independent actual Electron apps on one Windows PC, bundled renderer/preload/native WSS, synthetic camera and 48kHz WAV microphones, muted OS output.',
    diagnosticPermissionOverride: diagnosticPermissions, freshProfilesNoNearbyRooms: true, physicalDifferentNetworkTest: false, hardwareSensorsUsed: false, nativeInputInjected: false,
    sourceHashes: Object.fromEntries(['src/main.cjs', 'src/preload.cjs', 'src/renderer/app.js', 'src/renderer/rtc.js'].map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')])) };
  try {
    for (let index = 0; index < 2; index++) {
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
      const application = await _electron.launch({ args: [root, '--smoke-test', `--user-data-dir=${path.join(workspace, `profile-${index}`)}`, '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`, '--mute-audio', '--autoplay-policy=no-user-gesture-required'], env, timeout: 60000 });
      const client = { application, page: await application.firstWindow(), forgotten: false }; clients.push(client);
      await client.page.context().addInitScript(() => {
        window.qaRTCs = []; window.qaCandidates = []; window.qaCaptureCalls = []; window.qaStreams = []; window.qaPageErrors = 0; window.qaBrowserSocketConstructions = 0;
        const Capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async constraints => { qaCaptureCalls.push({ audio: Boolean(constraints.audio), video: Boolean(constraints.video) }); const stream = await Capture(constraints); qaStreams.push(stream); return stream; };
        const RTC = window.RTCPeerConnection; window.RTCPeerConnection = new Proxy(RTC, { construct(target, args) { const pc = Reflect.construct(target, args); qaRTCs.push(pc); pc.addEventListener('icecandidate', ({ candidate }) => { if (candidate) qaCandidates.push({ type: candidate.type, protocol: candidate.protocol }); }); return pc; } });
        const Socket = window.WebSocket; window.WebSocket = new Proxy(Socket, { construct(target, args) { qaBrowserSocketConstructions++; return Reflect.construct(target, args); } });
      });
      client.page.on('pageerror', () => { void client.page.evaluate(() => qaPageErrors++).catch(() => {}); });
      await client.page.reload(); await client.page.locator('#host-button').waitFor();
      assert.equal(await client.page.evaluate(() => typeof window.auralink.internetOpen), 'function');
      assert.equal((await client.page.evaluate(() => window.auralink.getInfo())).testing, true);
      if (diagnosticPermissions) {
        // Diagnostic run only, after an unmodified baseline. Scope the temporary
        // network exception to this app's exact trusted main frame. Fake media
        // means this diagnostic cannot authorize physical sensor access.
        await application.evaluate(({ session, BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows()[0]; const bundledURL = window.webContents.getURL().split('#')[0];
          const trusted = (contents, details = {}) => contents === window.webContents && contents.getURL().split('#')[0] === bundledURL && details.isMainFrame !== false;
          const allowed = new Set(['media', 'display-capture', 'speaker-selection', 'local-network', 'local-network-access', 'loopback-network']);
          session.defaultSession.setPermissionCheckHandler((contents, permission, _origin, details = {}) => trusted(contents, details) && allowed.has(permission));
          session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details = {}) => callback(trusted(contents, details) && allowed.has(permission)));
        });
      }
      await pair(client.page, names[index], pairingKey);
    }
    proof.nativePairingBoth = true; const [owner, guest] = clients.map(client => client.page);
    phase = 'owner room and guest admission'; await owner.locator('.nav-item[data-view="rooms"]').click(); await owner.locator('#host-button').click(); await owner.locator('#host-mode').selectOption('internet'); await owner.locator('#host-name').fill('Actual Electron synthetic media QA'); await owner.locator('#create-room').click();
    await owner.waitForFunction(() => document.getElementById('invite-dialog').open); const invitation = await owner.locator('#invite-value').inputValue(); await owner.locator('#invite-dialog [data-close]').click();
    await guest.locator('.nav-item[data-view="rooms"]').click(); await guest.locator('#join-button').click(); await guest.locator('#join-invite').fill(invitation); await guest.locator('#join-submit').click();
    await owner.waitForFunction(() => !document.getElementById('pending-banner').hidden); assert.equal(await guest.locator('#mic-button').isDisabled(), true); assert.equal(await guest.evaluate(() => qaCaptureCalls.length), 0);
    await owner.locator('#review-requests').click(); await owner.locator('#request-list').getByRole('button', { name: 'Accept', exact: true }).click(); await owner.locator('#requests-dialog [data-close]').click();
    await guest.waitForFunction(() => !document.getElementById('camera-button').disabled);
    for (const page of [owner, guest]) { assert.equal(await page.evaluate(() => qaCaptureCalls.length), 0); assert.equal(await page.evaluate(() => qaBrowserSocketConstructions), 0); }
    proof.nativeAdmissionBoth = true; proof.noAutomaticCapture = true; proof.noRendererBrowserWebSocket = true;
    phase = 'bidirectional synthetic camera and microphone';
    for (const page of [owner, guest]) await page.locator('#camera-button').click();
    for (const page of [owner, guest]) await page.locator('#mic-button').click();
    proof.ownerReceiver = await mediaProof(owner, names[1]); proof.guestReceiver = await mediaProof(guest, names[0]);
    proof.decodedBidirectionalVideoAndAudio = true;
    phase = 'microphone stop and restart';
    const energy = Math.max(...proof.guestReceiver.rtc.flatMap(pc => pc.inbound).filter(row => row.kind === 'audio').map(row => row.totalAudioEnergy || 0));
    await owner.locator('#mic-button').click(); await guest.waitForFunction(() => ![...document.querySelectorAll('audio[data-peer]')].some(audio => audio.srcObject));
    await owner.locator('#mic-button').click(); proof.guestAfterMicRestart = await mediaProof(guest, names[0], energy); proof.microphoneRestartDecoded = true;
    phase = 'room and media teardown'; await guest.locator('#end-button').click(); await guest.waitForFunction(() => document.getElementById('session').hidden && !document.getElementById('host-button').disabled);
    await owner.locator('#end-button').click(); await owner.waitForFunction(() => document.getElementById('session').hidden && !document.getElementById('host-button').disabled);
    for (const page of [owner, guest]) { assert.equal(await page.locator('#internet-status').textContent(), 'Online'); assert.ok(await page.evaluate(() => qaStreams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')))); }
    proof.leaveStopsCaptureKeepsDirectory = true;
    for (const client of clients) {
      await client.page.locator('.nav-item[data-view="settings"]').click(); await client.page.locator('#internet-forget').click();
      await client.page.waitForFunction(() => document.getElementById('internet-status').textContent === 'Offline');
      assert.equal(await client.page.evaluate(value => localStorage.getItem(`auralink.internet.identity:${value}`), origin), null); client.forgotten = true;
    }
    proof.bothDevicesForgottenWithAcknowledgment = true; assert.ok((await Promise.all(clients.map(client => snapshot(client.page)))).every(item => item.pageErrors === 0)); proof.passed = true;
  } catch {
    proof.failedStage = phase; proof.diagnostics = await Promise.all(clients.map(async client => { try { return await snapshot(client.page); } catch { return { unavailable: true }; } })); process.exitCode = 1;
  } finally {
    for (const client of clients) {
      if (!client.forgotten) {
        let identity;
        try { identity = await client.page.evaluate(value => JSON.parse(localStorage.getItem(`auralink.internet.identity:${value}`) || 'null'), origin); await forgetIdentity(identity); client.forgotten = true; }
        catch {
          if (identity) { const recovery = path.join(root, '.private', `electron-media-cleanup-${nameSuffix}-${clients.indexOf(client)}.json`); fs.mkdirSync(path.dirname(recovery), { recursive: true }); fs.writeFileSync(recovery, JSON.stringify({ origin, identity })); }
          proof.cleanupRequiresPrivateRecovery = true;
        }
      }
      await client.application.close().catch(() => {});
    }
    proof.cleanupConfirmed = clients.length === 2 && clients.every(client => client.forgotten); proof.testedAt = new Date().toISOString();
    proof.electron = fs.readFileSync(path.join(root, 'node_modules/electron/dist/version'), 'utf8').trim();
    const name = diagnosticPermissions ? 'internet-electron-media-network-diagnostic' : 'internet-electron-media';
    fs.writeFileSync(path.join(output, `${name}.json`), JSON.stringify(proof, null, 2)); console.log(JSON.stringify(proof, null, 2));
    const resolved = fs.realpathSync(workspace), results = fs.realpathSync(output);
    if (resolved.startsWith(results + path.sep) && path.basename(resolved).startsWith('internet-electron-media-')) fs.rmSync(resolved, { recursive: true, force: true });
  }
}
main().catch(() => { console.error('Actual Electron media verification could not complete; private details withheld.'); process.exitCode = 1; });
