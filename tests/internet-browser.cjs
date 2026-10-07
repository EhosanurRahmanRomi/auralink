'use strict';

// Real renderer and WebRTC through the actual local workerd/SQLite coordinator.
// A local TLS proxy supplies browser HTTPS; native consent/input and display
// capture are explicit fixtures. No external service or physical device is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { createHash, X509Certificate } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const WebSocket = require('ws');
const selfsigned = require('selfsigned');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'test-results');
const browserPath = [process.env.AURALINK_TEST_BROWSER, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/google-chrome'].filter(Boolean).find(file => fs.existsSync(file));
if (!browserPath) throw new Error('Install Edge/Chrome or set AURALINK_TEST_BROWSER.');

async function secureProxy(runtime) {
  const cert = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], { keySize: 2048, algorithm: 'sha256' });
  const assets = path.join(root, 'src/renderer'); const connections = new Set();
  const server = https.createServer({ key: cert.private, cert: cert.cert, minVersion: 'TLSv1.2' }, (request, response) => {
    const url = new URL(request.url, 'https://localhost'); const file = path.resolve(assets, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    if (!file.startsWith(assets + path.sep) || !fs.existsSync(file)) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', 'Cache-Control': 'no-store' }); response.end(fs.readFileSync(file));
  });
  const wss = new WebSocket.Server({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/internet/ws') { socket.destroy(); return; }
    wss.handleUpgrade(request, socket, head, client => {
      const upstream = new WebSocket(runtime.url.replace(/^http/, 'ws') + '/internet/ws'); const entry = { client, upstream }; connections.add(entry); const queue = [];
      client.on('message', data => { if (upstream.readyState === WebSocket.OPEN) upstream.send(data.toString()); else queue.push(data.toString()); });
      upstream.on('open', () => { for (const data of queue) upstream.send(data); queue.length = 0; });
      upstream.on('message', data => { if (client.readyState === WebSocket.OPEN) client.send(data.toString()); });
      upstream.on('close', () => { connections.delete(entry); if (client.readyState === WebSocket.OPEN) client.close(); });
      client.on('close', () => { connections.delete(entry); upstream.close(); });
      upstream.on('error', () => client.close()); client.on('error', () => upstream.close());
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const spkiHash = createHash('sha256').update(new X509Certificate(cert.cert).publicKey.export({ format: 'der', type: 'spki' })).digest('base64');
  return { origin: `https://127.0.0.1:${server.address().port}`, spkiHash, connections,
    close: async () => { for (const { client, upstream } of connections) { client.terminate(); upstream.terminate(); } await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => server.close(resolve)); } };
}

async function pair(page, origin, pairingKey, name, uiOrigin = origin) {
  await page.goto(uiOrigin); await page.locator('#internet-settings-button').click();
  await page.locator('#display-name').fill(name); await page.locator('#save-settings').click();
  await page.locator('#internet-service').fill(origin); await page.locator('#internet-pairing-code').fill(pairingKey); await page.locator('#internet-go-online').click();
  await page.waitForFunction(() => document.getElementById('internet-status').textContent === 'Online');
  assert.equal(await page.locator('#internet-pairing-code').inputValue(), '');
  const storage = await page.evaluate(() => Object.values(localStorage).join(''));
  assert.ok(!storage.includes(pairingKey), 'Pairing code must not be persisted');
}
async function visitRooms(page) { await page.locator('.nav-item[data-view="rooms"]').click(); }
async function joinApproved(page, owner, invite) {
  await visitRooms(page); await page.locator('#join-button').click(); await page.locator('#join-invite').fill(invite); await page.locator('#join-submit').click();
  await owner.waitForFunction(() => !document.getElementById('pending-banner').hidden); await review(owner, true); await page.waitForFunction(() => !document.getElementById('mic-button').disabled);
}
async function review(page, accept) {
  await page.locator('#review-requests').click();
  await page.locator('#request-list').getByRole('button', { name: accept ? 'Accept' : 'Decline', exact: true }).click();
  await page.locator('#requests-dialog [data-close]').click();
}
async function mediaProof(page, name) {
  const audioBefore = await page.evaluate(async () => {
    const values = await Promise.all(qaRTCs.filter(pc => pc.connectionState === 'connected').map(async pc => [...(await pc.getStats()).values()].filter(row => row.type === 'inbound-rtp' && row.kind === 'audio').map(row => [row.trackIdentifier, row.totalAudioEnergy || 0])));
    return Object.fromEntries(values.flat());
  });
  await page.getByRole('button', { name: `View ${name}`, exact: true }).click();
  await page.waitForFunction(() => { const video = document.getElementById('stage-video'); return !video.hidden && video.videoWidth > 0 && video.readyState >= 2 && video.currentTime > 0; }, null, { timeout: 20000 });
  await page.locator('#diagnostics-toggle').click();
  await page.waitForFunction(() => document.getElementById('rtc-stats').textContent.includes('Audio received') && /Audio received\d+ packets/.test(document.getElementById('rtc-stats').textContent), null, { timeout: 20000 });
  await page.waitForFunction(async before => (await Promise.all(qaRTCs.filter(pc => pc.connectionState === 'connected').map(pc => pc.getStats()))).some(report => [...report.values()].some(row => row.type === 'inbound-rtp' && row.kind === 'audio' && row.packetsReceived > 10 && row.totalAudioEnergy > (before[row.trackIdentifier] || 0) + .00001)), audioBefore, { timeout: 20000 });
  const proof = await page.evaluate(() => { const video = document.getElementById('stage-video'); return { width: video.videoWidth, height: video.videoHeight, currentTime: video.currentTime, stats: document.getElementById('rtc-stats').innerText, rtcConfiguration: qaRTCConfigs.map(config => ({ ...config, iceServers: config.iceServers.map(server => ({ urls: server.urls, hasRelayCredential: Boolean(server.credential) })) })) }; });
  proof.audio = await page.evaluate(async () => (await Promise.all(qaRTCs.filter(pc => pc.connectionState === 'connected').map(async pc => [...(await pc.getStats()).values()].filter(row => row.type === 'inbound-rtp' && row.kind === 'audio').map(row => ({ packetsReceived: row.packetsReceived, totalAudioEnergy: row.totalAudioEnergy, totalSamplesDuration: row.totalSamplesDuration, muted: pc.getReceivers().find(receiver => receiver.track.id === row.trackIdentifier)?.track.muted }))))).flat());
  assert.ok(proof.audio.some(audio => audio.totalAudioEnergy > 0 && audio.muted === false), 'A received microphone must produce actual decoded audio energy on an unmuted track');
  assert.ok(proof.rtcConfiguration.some(config => config.iceServers.some(server => String(server.urls).startsWith('stun:'))), 'Coordinator ICE configuration must be set before peer construction');
  await page.locator('#diagnostics-close').click(); return proof;
}
async function forgetTestIdentity(origin, identity) {
  if (!identity?.deviceId || !identity?.deviceToken) return;
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(origin.replace(/^https:/, 'wss:') + '/internet/ws');
    const timer = setTimeout(() => { socket.terminate(); reject(new Error('Test identity cleanup timed out.')); }, 12000);
    const finish = error => { clearTimeout(timer); socket.close(); error ? reject(error) : resolve(); };
    socket.once('open', () => socket.send(JSON.stringify({ type: 'register', ...identity, name: 'QA cleanup' })));
    socket.on('message', raw => { const packet = JSON.parse(raw.toString()); if (packet.type === 'registered') socket.send(JSON.stringify({ type: 'forget' })); else if (packet.type === 'forgotten') finish(); else if (packet.type === 'error') finish(new Error('The public service rejected test identity cleanup.')); });
    socket.once('error', () => finish(new Error('Public test identity cleanup could not connect.')));
  });
}
async function main() {
  fs.mkdirSync(output, { recursive: true }); let runtime, proxy, browser; let phase = 'setup'; const errors = []; const contexts = []; const proof = {};
  const publicMode = Boolean(process.env.AURALINK_PUBLIC_ORIGIN); const evidenceName = publicMode ? 'internet-public-browser' : 'internet-browser';
  const signalDelay = Number(process.env.AURALINK_QA_SIGNAL_DELAY_MS || 0);
  if (!Number.isInteger(signalDelay) || signalDelay < 0 || signalDelay > 1000) throw new Error('The test signaling delay must be an integer from 0 to 1000 ms.');
  const suffix = publicMode ? ` ${Date.now().toString(36)}` : ''; const hostName = `QA desktop${suffix}`; const guestName = `QA phone${suffix}`;
  try {
    if (publicMode) {
      const secretFile = process.env.AURALINK_SECRETS_FILE;
      if (!secretFile) throw new Error('Set AURALINK_SECRETS_FILE to the local private JSON file; never put pairing secrets in command arguments.');
      const key = JSON.parse(fs.readFileSync(secretFile, 'utf8')).PAIRING_KEY;
      if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(key)) throw new Error('The private JSON does not contain a valid PAIRING_KEY.');
      const address = new URL(process.env.AURALINK_PUBLIC_ORIGIN);
      if (address.protocol !== 'https:' || address.username || address.password || address.search || address.hash || address.pathname !== '/') throw new Error('The public coordinator must be a clean HTTPS origin.');
      runtime = { url: address.origin, pairingKey: key, close: async () => {} };
    } else {
      const { createLocalCoordinator } = await import(pathToFileURL(path.join(root, 'internet-service/tests/local-runtime.mjs')).href);
      runtime = await createLocalCoordinator();
    }
    proxy = await secureProxy(runtime); const serviceOrigin = publicMode ? runtime.url : proxy.origin;
    browser = await chromium.launch({ executablePath: browserPath, headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns', `--ignore-certificate-errors-spki-list=${proxy.spkiHash}`] });
    proof.browser = { executable: path.basename(browserPath), version: browser.version() };
    const desktop = await browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 1360, height: 940 } });
    const mobile = await browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true }); contexts.push(desktop, mobile);
    for (const context of contexts) {
      await context.addInitScript(({ signalDelay }) => {
        window.qaCaptureCalls = []; window.qaStreams = []; window.qaRTCConfigs = []; window.qaRTCs = []; window.qaChannels = []; window.qaReceivedInputs = []; window.qaTrackEvents = []; window.qaSignaling = []; window.qaNative = { grants: [], revokes: 0, inputs: [] }; window.qaWaiting = []; window.qaHolds = new Map();
        window.qaHold = label => qaHolds.set(label, { promise: new Promise(resolve => { window.qaPendingResolve = resolve; }), resolve: qaPendingResolve });
        window.qaRelease = label => { const hold = qaHolds.get(label); qaHolds.delete(label); hold?.resolve(); };
        window.qaPause = async label => { const hold = qaHolds.get(label); if (hold) { qaWaiting.push(label); await hold.promise; qaWaiting = qaWaiting.filter(item => item !== label); } };
        const NativeSocket = window.WebSocket;
        function recordSignal(direction, packet) {
          if (packet.type === 'welcome') qaSignaling.push({ direction, type: 'welcome', selfId: packet.selfId, peers: packet.peers.map(peer => peer.id), time: performance.now() });
          if (packet.type === 'signal' && (packet.data.description || packet.data.mediaState)) qaSignaling.push({ direction, type: 'signal', peerId: packet.to || packet.from, descriptionType: packet.data.description?.type, trackKinds: packet.data.trackKinds, midKinds: packet.data.midKinds, mediaState: packet.data.mediaState, time: performance.now() });
          if (qaSignaling.length > 300) qaSignaling.shift();
        }
        window.WebSocket = new Proxy(NativeSocket, { construct(target, args) { const socket = Reflect.construct(target, args); const listen = socket.addEventListener.bind(socket); const send = socket.send.bind(socket); socket.send = raw => { try { recordSignal('out', JSON.parse(raw)); } catch {} return send(raw); }; socket.addEventListener = (type, callback, options) => listen(type, type === 'message' ? async event => { try { const packet = JSON.parse(event.data); recordSignal('in', packet); if (['room-created', 'room-left'].includes(packet.type)) await qaPause(packet.type); if (packet.type === 'signal' && signalDelay) await new Promise(resolve => setTimeout(resolve, signalDelay)); } catch {} callback(event); } : callback, options); return socket; } });
        function recordChannel(channel) { qaChannels.push(channel); channel.addEventListener('message', ({ data }) => { try { const packet = JSON.parse(data); if (packet.type === 'input') qaReceivedInputs.push(packet); } catch {} }); }
        const NativeRTC = window.RTCPeerConnection; window.RTCPeerConnection = new Proxy(NativeRTC, { construct(target, args) { qaRTCConfigs.push(args[0]); const pc = Reflect.construct(target, args); qaRTCs.push(pc); pc.addEventListener('track', ({ track, transceiver }) => { qaTrackEvents.push({ type: 'track', id: track.id, kind: track.kind, mid: transceiver.mid, muted: track.muted }); for (const type of ['mute', 'unmute', 'ended']) track.addEventListener(type, () => qaTrackEvents.push({ type, id: track.id, kind: track.kind, muted: track.muted })); }); const createChannel = pc.createDataChannel.bind(pc); pc.createDataChannel = (...values) => { const channel = createChannel(...values); recordChannel(channel); return channel; }; pc.addEventListener('datachannel', ({ channel }) => recordChannel(channel)); return pc; } });
        const nativeCapture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async config => { qaCaptureCalls.push(config); const stream = await nativeCapture(config); qaStreams.push(stream); return stream; };
        navigator.mediaDevices.getDisplayMedia = async () => { await qaPause('display'); const canvas = document.createElement('canvas'); canvas.width = 960; canvas.height = 540; const context = canvas.getContext('2d'); let frame = 0;
          const timer = setInterval(() => { context.fillStyle = frame++ % 2 ? '#244360' : '#287f69'; context.fillRect(0, 0, 960, 540); context.fillStyle = 'white'; context.font = '40px sans-serif'; context.fillText(`Synthetic shared desktop ${frame}`, 60, 120); }, 70);
          const stream = canvas.captureStream(12); const track = stream.getVideoTracks()[0]; track.addEventListener('ended', () => clearInterval(timer)); track.applyConstraints = async () => { await qaPause('constraints'); }; qaStreams.push(stream); return stream; };
        window.auralink = { platform: 'qa-browser-fixture', getInfo: async () => ({ platform: 'Browser test fixture' }), requestMedia: async () => { await qaPause('permission'); return { ok: true }; }, sources: async () => { await qaPause('sources'); return [{ id: 'screen:qa', name: 'Synthetic desktop' }]; }, chooseScreen: async () => { await qaPause('selection'); }, stopSharing: async () => {},
          onScreenStopped: listener => { window.qaScreenStopped = listener; return () => {}; },
          grantControl: async request => { qaNative.grants.push(request); await qaPause('grant'); return { ok: true }; }, revokeControl: async () => { qaNative.revokes++; }, applyInput: async input => { qaNative.inputs.push(input); } };
      }, { signalDelay });
    }
    const host = await desktop.newPage(); const guest = await mobile.newPage();
    for (const page of [host, guest]) page.on('pageerror', error => errors.push(`${phase}: ${error.message}`));
    phase = 'pair and presence'; await pair(host, serviceOrigin, runtime.pairingKey, hostName, proxy.origin); await pair(guest, serviceOrigin, runtime.pairingKey, guestName, proxy.origin);
    await guest.locator('.nav-item[data-view="devices"]').click(); const hostCard = guest.locator('#online-device-list .device-card').filter({ has: guest.getByRole('heading', { name: hostName, exact: true }) });
    await hostCard.waitFor(); assert.match(await hostCard.innerText(), /Online/); assert.equal(await hostCard.getByRole('button', { name: 'Request connection' }).isDisabled(), true);
    if (!publicMode) { await host.screenshot({ path: path.join(output, 'internet-settings-desktop.png'), fullPage: true }); await guest.screenshot({ path: path.join(output, 'internet-devices-phone.png'), fullPage: true }); }
    phase = 'cancel an Internet room before its creation reply'; await visitRooms(host); await host.locator('#host-button').click(); await host.locator('#host-mode').selectOption('internet'); await host.locator('#host-name').fill('Cancelled Internet room'); await host.evaluate(() => qaHold('room-created')); await host.locator('#create-room').click(); await host.waitForFunction(() => qaWaiting.includes('room-created'));
    await host.evaluate(() => qaHold('room-left')); await host.locator('#host-dialog [data-close]').click(); await host.waitForFunction(() => qaWaiting.includes('room-left')); assert.equal(await host.locator('#host-button').isDisabled(), true); assert.equal(await host.locator('#join-button').isDisabled(), true); await host.evaluate(() => qaRelease('room-left'));
    await host.waitForFunction(() => !document.getElementById('host-button').disabled); assert.equal(await host.locator('#internet-status').textContent(), 'Online'); proof.roomExitDisablesReplacementAdmissionUntilAcknowledged = true;
    await host.evaluate(() => qaRelease('room-created')); await host.waitForFunction(() => !qaWaiting.includes('room-created')); assert.equal(await host.locator('#session').isVisible(), false); proof.cancelledInternetCreationCannotOpenRoom = true;
    phase = 'create and reject'; await host.locator('#host-button').click(); await host.locator('#host-mode').selectOption('internet'); await host.locator('#host-name').fill('Across the world QA'); await host.locator('#create-room').click();
    await host.waitForFunction(() => document.getElementById('invite-dialog').open); const invite = await host.locator('#invite-value').inputValue(); assert.match(invite, /#internet=1&room=.+&key=/); assert.equal(await host.locator('#invite-fingerprint-box').isVisible(), false); await host.locator('#invite-dialog [data-close]').click();
    await hostCard.getByRole('button', { name: 'Request connection' }).waitFor(); await guest.waitForFunction(name => [...document.querySelectorAll('#online-device-list .device-card')].find(card => card.querySelector('h3')?.textContent === name)?.querySelector('button')?.disabled === false, hostName);
    await hostCard.getByRole('button', { name: 'Request connection' }).click();
    await host.waitForFunction(() => !document.getElementById('pending-banner').hidden); assert.equal(await guest.locator('#mic-button').isDisabled(), true); assert.equal(await guest.evaluate(() => qaCaptureCalls.length), 0);
    await review(host, false); await guest.waitForFunction(() => !document.getElementById('lobby').hidden);
    assert.equal(await guest.evaluate(() => qaCaptureCalls.length), 0);
    phase = 'invite and approve'; await visitRooms(guest); await guest.locator('#join-button').click(); await guest.locator('#join-invite').fill(invite); await guest.locator('#join-submit').click(); await host.waitForFunction(() => !document.getElementById('pending-banner').hidden); await review(host, true);
    await guest.waitForFunction(() => !document.getElementById('mic-button').disabled); assert.equal(await guest.evaluate(() => qaCaptureCalls.length), 0); assert.equal(await host.evaluate(() => qaCaptureCalls.length), 0);
    phase = 'real direct WebRTC'; await host.locator('#camera-button').click(); await guest.locator('#camera-button').click(); await host.locator('#mic-button').click(); await guest.locator('#mic-button').click();
    proof.hostReceiver = await mediaProof(host, guestName); proof.guestReceiver = await mediaProof(guest, hostName);
    phase = 'repeat rapid mic and camera toggles';
    await host.locator('#mic-button').click(); await guest.locator('#mic-button').click(); await host.locator('#camera-button').click(); await guest.locator('#camera-button').click();
    await host.waitForFunction(() => document.getElementById('stage-video').hidden); await guest.waitForFunction(() => document.getElementById('stage-video').hidden);
    await host.locator('#camera-button').click(); await guest.locator('#camera-button').click(); await host.locator('#mic-button').click(); await guest.locator('#mic-button').click();
    proof.hostReceiverAfterToggles = await mediaProof(host, guestName); proof.guestReceiverAfterToggles = await mediaProof(guest, hostName); proof.rapidMediaTogglesPreserveDecodedVideoAndAudio = true;
    phase = 'screen and separate control consent'; await host.locator('#share-button').click(); await host.getByRole('button', { name: 'Synthetic desktop' }).click();
    await guest.waitForFunction(() => { const video = document.getElementById('stage-video'); return video.videoWidth === 960 && video.videoHeight === 540 && document.getElementById('stage-label-text').textContent.includes('screen'); }, null, { timeout: 20000 }); proof.cameraAndScreenKeepSeparateMediaSlots = true;
    await guest.waitForFunction(() => !document.getElementById('request-control').disabled, null, { timeout: 20000 }); await guest.locator('#request-control').click();
    await host.waitForFunction(() => document.getElementById('control-dialog').open); assert.equal(await host.evaluate(() => qaNative.grants.length), 0); await host.locator('#deny-control').click();
    phase = 'control decline then renewed request';
    await guest.waitForFunction(() => document.getElementById('request-control').querySelector('small').textContent === 'Request control'); await guest.locator('#request-control').click(); await host.waitForFunction(() => document.getElementById('control-dialog').open); await host.locator('#allow-control').click();
    await guest.waitForFunction(() => !document.getElementById('control-banner').hidden); assert.equal(await host.evaluate(() => qaNative.grants.length), 1); proof.separateConsent = true;
    const oldSession = await host.evaluate(() => qaNative.grants[0].sessionId);
    await guest.waitForFunction(() => qaChannels.some(channel => channel.readyState === 'open'));
    await guest.evaluate(sessionId => qaChannels.find(channel => channel.readyState === 'open').send(JSON.stringify({ type: 'input', sessionId, event: { type: 'keydown', code: 'Home', key: 'Home', seq: 1 } })), oldSession);
    await host.waitForFunction(() => qaNative.inputs.length === 1); proof.approvedEncryptedInputDeliveredToFixture = true;
    if (!publicMode) await guest.screenshot({ path: path.join(output, 'internet-room-phone.png'), fullPage: true });
    await host.locator('#stop-control').click(); await guest.waitForFunction(() => document.getElementById('control-banner').hidden); proof.ownerRevocation = true;
    const receivedBefore = await host.evaluate(() => qaReceivedInputs.length); const inputsBefore = await host.evaluate(() => qaNative.inputs.length);
    await guest.evaluate(sessionId => qaChannels.find(channel => channel.readyState === 'open').send(JSON.stringify({ type: 'input', sessionId, event: { type: 'keydown', code: 'Home', key: 'Home', seq: 999 } })), oldSession);
    await host.waitForFunction(count => qaReceivedInputs.length > count, receivedBefore); assert.equal(await host.evaluate(() => qaNative.inputs.length), inputsBefore); proof.revokedInputActuallyDeliveredAndRejected = true;
    phase = 'renewed approval rejects old encrypted session';
    await guest.locator('#request-control').click(); await host.waitForFunction(() => document.getElementById('control-dialog').open); await host.locator('#allow-control').click(); await guest.waitForFunction(() => !document.getElementById('control-banner').hidden);
    const freshSession = await host.evaluate(() => qaNative.grants.at(-1).sessionId); assert.notEqual(freshSession, oldSession);
    const priorReceived = await host.evaluate(() => qaReceivedInputs.length);
    await guest.evaluate(sessionId => qaChannels.find(channel => channel.readyState === 'open').send(JSON.stringify({ type: 'input', sessionId, event: { type: 'keydown', code: 'Home', key: 'Home', seq: 1000 } })), oldSession);
    await host.waitForFunction(count => qaReceivedInputs.length > count, priorReceived); assert.equal(await host.evaluate(() => qaNative.inputs.length), inputsBefore);
    await guest.evaluate(sessionId => qaChannels.find(channel => channel.readyState === 'open').send(JSON.stringify({ type: 'input', sessionId, event: { type: 'keydown', code: 'Home', key: 'Home', seq: 1 } })), freshSession);
    await host.waitForFunction(count => qaNative.inputs.length > count, inputsBefore); proof.freshConsentRejectsOldSessionAndAllowsFresh = true;
    await host.locator('#stop-control').click(); await guest.waitForFunction(() => document.getElementById('control-banner').hidden);
    phase = 'native approval cannot authorize a replacement share';
    await host.evaluate(() => qaHold('grant')); await guest.locator('#request-control').click(); await host.waitForFunction(() => document.getElementById('control-dialog').open); await host.locator('#allow-control').click(); await host.waitForFunction(() => qaWaiting.includes('grant'));
    await host.evaluate(() => document.getElementById('share-button').click()); await host.waitForFunction(() => !document.getElementById('share-button').disabled && document.getElementById('share-button').getAttribute('aria-label') === 'Share screen');
    await host.locator('#share-button').click(); await host.getByRole('button', { name: 'Synthetic desktop' }).click(); await host.waitForFunction(() => document.getElementById('share-button').getAttribute('aria-label') === 'Stop sharing screen');
    const revokeCount = await host.evaluate(() => qaNative.revokes); await host.evaluate(() => qaRelease('grant')); await host.waitForFunction(count => qaNative.revokes > count, revokeCount);
    assert.equal(await guest.locator('#control-banner').isVisible(), false); assert.equal(await host.locator('#control-banner').isVisible(), false); proof.delayedConsentCannotAuthorizeReplacementShare = true;
    phase = 'room leave keeps presence'; await guest.locator('#end-button').click(); await guest.waitForFunction(() => !document.getElementById('lobby').hidden); assert.equal(await guest.locator('#internet-status').textContent(), 'Online');
    assert.ok(await guest.evaluate(() => qaStreams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')))); proof.normalLeaveKeepsDirectory = true;
    phase = 'cancel a display while constraints are pending';
    await joinApproved(guest, host, invite); await guest.evaluate(() => qaHold('constraints')); await guest.locator('#share-button').click(); await guest.getByRole('button', { name: 'Synthetic desktop' }).click(); await guest.waitForFunction(() => qaWaiting.includes('constraints'));
    await guest.locator('#end-button').click(); await guest.waitForFunction(() => !document.getElementById('lobby').hidden); await guest.evaluate(() => qaRelease('constraints'));
    await guest.waitForFunction(() => qaStreams.every(stream => stream.getTracks().every(track => track.readyState === 'ended'))); assert.equal(await guest.locator('#screen-dialog').isVisible(), false); proof.delayedScreenConstraintsCannotRestoreCapture = true;
    phase = 'cancel native permission before capture and rejoin';
    await joinApproved(guest, host, invite); const capturesBefore = await guest.evaluate(() => qaCaptureCalls.length); await guest.evaluate(() => qaHold('permission')); await guest.locator('#mic-button').click(); await guest.waitForFunction(() => qaWaiting.includes('permission'));
    await guest.locator('#end-button').click(); await guest.waitForFunction(() => !document.getElementById('lobby').hidden); await joinApproved(guest, host, invite); await guest.evaluate(() => qaRelease('permission')); await guest.waitForFunction(() => !qaWaiting.includes('permission'));
    assert.equal(await guest.evaluate(() => qaCaptureCalls.length), capturesBefore, 'A cancelled native permission result must never invoke capture in the replacement room'); assert.equal(await guest.locator('#mic-button').getAttribute('aria-label'), 'Turn microphone on'); assert.equal(await guest.locator('#mic-button').isDisabled(), false); proof.delayedPermissionCannotCaptureInNewRoom = true;
    phase = 'cancel source discovery before picker';
    await guest.evaluate(() => qaHold('sources')); await guest.locator('#share-button').click(); await guest.waitForFunction(() => qaWaiting.includes('sources')); await guest.locator('#end-button').click(); await guest.waitForFunction(() => !document.getElementById('lobby').hidden); await guest.evaluate(() => qaRelease('sources')); await guest.waitForFunction(() => !qaWaiting.includes('sources'));
    assert.equal(await guest.locator('#screen-dialog').isVisible(), false); proof.delayedSourceDiscoveryCannotReopenPicker = true;
    phase = 'old Android projection reply cannot stop a replacement room';
    await guest.evaluate(() => {
      // The actual renderer receives a deliberately delayed native result.
      // This fixture models native capture generations; an unscoped stale stop
      // really would stop the newer projection and is therefore observable.
      const phone = window.qaPhone = { active: '', starts: [], stops: [], aliasStops: [], acks: [], tracks: [], frame: null, stopped: window.qaScreenStopped, timer: null, seq: 0 };
      const NativeGenerator = window.MediaStreamTrackGenerator;
      window.MediaStreamTrackGenerator = new Proxy(NativeGenerator, { construct(target, args) { const track = Reflect.construct(target, args); phone.tracks.push(track); return track; } });
      const canvas = document.createElement('canvas'); canvas.width = 720; canvas.height = 1280; const drawing = canvas.getContext('2d'); drawing.fillStyle = '#168471'; drawing.fillRect(0, 0, 720, 1280);
      phone.jpeg = canvas.toDataURL('image/jpeg', .7);
      phone.send = captureId => phone.frame?.({ captureId, seq: ++phone.seq, data: phone.jpeg, width: 720, height: 1280 });
      Object.assign(window.auralink, { platform: 'android',
        startScreenShare: async () => { const captureId = `qa-projection-${phone.starts.length + 1}`; phone.starts.push(captureId); phone.active = captureId; if (phone.starts.length === 1) await qaPause('phone-start'); return { id: 'android-screen', captureId, width: 720, height: 1280 }; },
        stopScreenShare: async request => { phone.stops.push(request || null); if (!request?.captureId || request.captureId === phone.active) { phone.active = ''; clearInterval(phone.timer); phone.timer = null; } if (request?.captureId) await qaPause(`phone-stop:${request.captureId}`); return { ok: true }; },
        stopSharing: async request => { phone.aliasStops.push(request || null); return window.auralink.stopScreenShare(request); },
        onScreenFrame: listener => { phone.frame = listener; return () => { if (phone.frame === listener) phone.frame = null; }; },
        ackScreenFrame: async packet => { phone.acks.push(packet); return { ok: true }; },
      });
    });
    await joinApproved(guest, host, invite); await guest.evaluate(() => qaHold('phone-start')); await guest.locator('#share-button').click(); await guest.waitForFunction(() => qaWaiting.includes('phone-start'));
    await guest.locator('#end-button').click(); await guest.waitForFunction(() => !document.getElementById('lobby').hidden); await joinApproved(guest, host, invite); await guest.locator('#share-button').click(); await guest.waitForFunction(() => document.getElementById('share-button').getAttribute('aria-label') === 'Stop sharing screen');
    await guest.evaluate(() => qaRelease('phone-start')); await guest.waitForFunction(() => qaPhone.stops.some(request => request?.captureId === 'qa-projection-1'));
    assert.equal(await guest.evaluate(() => qaPhone.active), 'qa-projection-2'); assert.equal(await guest.locator('#share-button').getAttribute('aria-label'), 'Stop sharing screen');
    assert.equal(await guest.evaluate(() => qaPhone.tracks.at(-1).readyState), 'live'); proof.delayedAndroidStartCannotStopReplacementProjection = true;
    phase = 'old native phone events cannot stop or poison current capture';
    await guest.evaluate(() => { qaPhone.stopped('Old projection ended', { captureId: 'qa-projection-1' }); qaPhone.stopped('Missing capture identifier'); qaPhone.frame({ captureId: 'qa-projection-1', seq: 1000000, data: qaPhone.jpeg }); qaPhone.timer = setInterval(() => qaPhone.send('qa-projection-2'), 100); });
    await guest.waitForFunction(() => qaPhone.acks.some(packet => packet.captureId === 'qa-projection-1' && packet.seq === 1000000) && qaPhone.acks.some(packet => packet.captureId === 'qa-projection-2' && packet.seq < 1000000));
    await host.getByRole('button', { name: `View ${guestName}`, exact: true }).click(); await host.waitForFunction(() => { const video = document.getElementById('stage-video'); return video.videoWidth === 720 && video.videoHeight === 1280 && video.currentTime > 0; }, null, { timeout: 20000 });
    assert.equal(await guest.evaluate(() => qaPhone.active), 'qa-projection-2'); assert.equal(await guest.locator('#share-button').getAttribute('aria-label'), 'Stop sharing screen'); proof.oldAndroidFramesCannotPoisonReplacementSequence = true; proof.oldAndroidStoppedEventCannotStopReplacementProjection = true;
    phase = 'delayed Android stop cannot clean up a replacement room';
    await guest.evaluate(() => { qaHold('phone-stop:qa-projection-2'); qaPhone.stopped('Current projection ended', { captureId: 'qa-projection-2' }); }); await guest.waitForFunction(() => qaWaiting.includes('phone-stop:qa-projection-2')); assert.equal(await guest.evaluate(() => qaPhone.active), ''); proof.currentAndroidStoppedEventStopsItsProjection = true;
    await guest.locator('#end-button').click(); await guest.waitForFunction(() => !document.getElementById('lobby').hidden); await joinApproved(guest, host, invite); await guest.locator('#share-button').click(); await guest.waitForFunction(() => document.getElementById('share-button').getAttribute('aria-label') === 'Stop sharing screen');
    const aliasStopsBefore = await guest.evaluate(() => qaPhone.aliasStops.length); await guest.evaluate(() => qaRelease('phone-stop:qa-projection-2')); await guest.waitForFunction(() => !qaWaiting.includes('phone-stop:qa-projection-2'));
    assert.equal(await guest.evaluate(() => qaPhone.aliasStops.length), aliasStopsBefore, 'An obsolete stop continuation must not invoke the native stop alias'); assert.equal(await guest.evaluate(() => qaPhone.active), 'qa-projection-3'); assert.equal(await guest.evaluate(() => qaPhone.tracks.at(-1).readyState), 'live'); proof.delayedAndroidStopCannotStopReplacementProjection = true;
    await guest.locator('#share-button').click(); await guest.waitForFunction(() => !document.getElementById('share-button').disabled); assert.ok(await guest.evaluate(() => qaPhone.aliasStops.some(request => request?.captureId === 'qa-projection-3')), 'Current capture stop aliases carry the same projection identity');
    await guest.locator('#end-button').click(); await guest.waitForFunction(() => !document.getElementById('lobby').hidden);
    await guest.locator('.nav-item[data-view="devices"]').click(); await guest.waitForFunction(name => [...document.querySelectorAll('#online-device-list .device-card')].find(card => card.querySelector('h3')?.textContent === name)?.querySelector('button')?.disabled === false, hostName); await hostCard.getByRole('button', { name: 'Request connection' }).click(); await host.waitForFunction(() => !document.getElementById('pending-banner').hidden); await review(host, true); await guest.waitForFunction(() => !document.getElementById('mic-button').disabled); await guest.locator('#mic-button').click();
    phase = 'connection loss stops media and does not resume room';
    // All service connections are cut to simulate a network interruption.
    if (!publicMode) {
      for (const { client, upstream } of [...proxy.connections]) { client.terminate(); upstream.terminate(); }
      await guest.waitForFunction(() => !document.getElementById('lobby').hidden); await host.waitForFunction(() => !document.getElementById('lobby').hidden);
      assert.ok(await guest.evaluate(() => qaStreams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')))); assert.ok(await host.evaluate(() => qaStreams.every(stream => stream.getTracks().every(track => track.readyState === 'ended'))));
      await guest.waitForFunction(() => document.getElementById('internet-status').textContent === 'Online'); await host.waitForFunction(() => document.getElementById('internet-status').textContent === 'Online');
      assert.equal(await guest.locator('#session').isVisible(), false); assert.equal(await host.locator('#session').isVisible(), false); proof.disconnectStopsMediaAndNoRoomResume = true;
    } else { proof.connectionLossBoundary = 'Connection-loss and no-room-resume behavior tested in the separate local workerd/browser proof; not injected into this public coordinator test.'; await guest.locator('#end-button').click(); }
    phase = 'forget'; await guest.locator('.nav-item[data-view="settings"]').click(); await guest.locator('#internet-forget').click(); await guest.waitForFunction(() => document.getElementById('internet-status').textContent === 'Offline');
    assert.equal(await guest.evaluate(origin => localStorage.getItem(`auralink.internet.identity:${origin}`), serviceOrigin), null); proof.forgetRemovesLocalCredential = true;
    await host.locator('.nav-item[data-view="devices"]').click(); await host.waitForFunction(name => ![...document.querySelectorAll('#online-device-list h3')].some(el => el.textContent === name), guestName); proof.forgetRevokesDirectoryRecord = true;
    assert.deepEqual(errors, []); proof.status = 'passed'; proof.boundary = publicMode ? 'Two Chromium contexts on the same PC; public Cloudflare coordinator over normal CA-validated WSS, synthetic media/native consent. Media uses a direct local UDP route. This is not a cross-country, different-network or physical-device test.' : 'Local real workerd signaling and real Chromium WebRTC, synthetic media/native consent; no internet deployment or physical devices.';
    if (publicMode) { await host.locator('.nav-item[data-view="settings"]').click(); await host.locator('#internet-forget').click(); await host.waitForFunction(() => document.getElementById('internet-status').textContent === 'Offline'); proof.publicTestIdentitiesForgotten = true; }
    for (const file of [`${evidenceName}-failure.json`, 'internet-failure-0.png', 'internet-failure-1.png']) { const target = path.join(output, file); if (fs.existsSync(target)) fs.unlinkSync(target); }
    fs.writeFileSync(path.join(output, `${evidenceName}.json`), JSON.stringify(proof, null, 2)); console.log(JSON.stringify(proof, null, 2));
  } catch (error) {
    const pages = [];
    for (const [i, context] of contexts.entries()) for (const page of context.pages()) {
      try { if (!publicMode) await page.screenshot({ path: path.join(output, `internet-failure-${i}.png`), fullPage: true }); pages.push(await page.evaluate(async () => ({ status: document.getElementById('connection-pill')?.textContent, toast: document.getElementById('toast-region')?.textContent, dialog: [...document.querySelectorAll('dialog[open]')].map(el => el.id), native: { grantCount: qaNative.grants.length, revokeCount: qaNative.revokes, inputCount: qaNative.inputs.length }, controlLabel: document.getElementById('request-control')?.innerText, captures: qaCaptureCalls, streams: qaStreams.map(stream => stream.getTracks().map(track => ({ id: track.id, kind: track.kind, enabled: track.enabled, readyState: track.readyState }))), visibility: document.visibilityState, stage: { hidden: document.getElementById('stage-video').hidden, width: document.getElementById('stage-video').videoWidth, height: document.getElementById('stage-video').videoHeight, time: document.getElementById('stage-video').currentTime, readyState: document.getElementById('stage-video').readyState, paused: document.getElementById('stage-video').paused, tracks: document.getElementById('stage-video').srcObject?.getTracks().map(track => ({ id: track.id, kind: track.kind, muted: track.muted, readyState: track.readyState })) }, trackEvents: qaTrackEvents, signaling: qaSignaling, rtc: await Promise.all(qaRTCs.map(async pc => ({ state: pc.connectionState, ice: pc.iceConnectionState, signaling: pc.signalingState, transceivers: pc.getTransceivers().map(item => ({ mid: item.mid, direction: item.direction, currentDirection: item.currentDirection, receiver: { id: item.receiver.track.id, kind: item.receiver.track.kind, readyState: item.receiver.track.readyState, muted: item.receiver.track.muted }, sender: item.sender.track ? { kind: item.sender.track.kind, readyState: item.sender.track.readyState } : null })), inbound: [...(await pc.getStats()).values()].filter(row => row.type === 'inbound-rtp').map(row => ({ kind: row.kind, trackIdentifier: row.trackIdentifier, ssrc: row.ssrc, mid: row.mid, packetsReceived: row.packetsReceived, framesDecoded: row.framesDecoded, width: row.frameWidth, height: row.frameHeight })) }))) }))); } catch {}
    }
    fs.writeFileSync(path.join(output, `${evidenceName}-failure.json`), JSON.stringify({ phase, browser: proof.browser, message: error.message, errors, pages }, null, 2)); throw error;
  }
  finally {
    if (publicMode) for (const context of contexts) for (const page of context.pages()) {
      try {
        const identity = await page.evaluate(origin => JSON.parse(localStorage.getItem(`auralink.internet.identity:${origin}`) || 'null'), runtime.url);
        if (identity) await forgetTestIdentity(runtime.url, identity);
      } catch { console.error('A public browser test identity could not be forgotten automatically.'); }
    }
    for (const context of contexts) await context.close(); await browser?.close(); await proxy?.close(); await runtime?.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
