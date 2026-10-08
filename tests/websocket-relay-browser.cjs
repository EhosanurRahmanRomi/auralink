'use strict';

// Actual bundled renderer, local workerd capability protocol and real Chromium
// WebSocket media fallback. Every real RTC instance is restricted to relay-only
// with no TURN servers: a direct connection is impossible. The public-origin socket
// is mapped to a local TLS coordinator fixture;
// native permissions/display/input are explicit fixtures, never OS input.
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
const live = process.argv.includes('--live');
const browserPath = [process.env.AURALINK_TEST_BROWSER, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/google-chrome'].filter(Boolean).find(file => fs.existsSync(file));
if (!browserPath) throw new Error('Install Edge/Chrome or set AURALINK_TEST_BROWSER.');

async function localHTTPS(runtime) {
  const cert = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], { keySize: 2048, algorithm: 'sha256' });
  const assets = path.join(root, 'src/renderer'); const connections = new Set();
  const server = https.createServer({ key: cert.private, cert: cert.cert, minVersion: 'TLSv1.2' }, (request, response) => {
    const file = path.resolve(assets, new URL(request.url, 'https://localhost').pathname.slice(1) || 'index.html');
    if (!file.startsWith(assets + path.sep) || !fs.existsSync(file)) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', 'Cache-Control': 'no-store' }); response.end(fs.readFileSync(file));
  });
  const wss = new WebSocket.Server({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/internet/ws') { socket.destroy(); return; }
    wss.handleUpgrade(request, socket, head, client => {
      const upstream = new WebSocket(runtime.url.replace(/^http/, 'ws') + '/internet/ws'); const entry = { client, upstream }; connections.add(entry); const queue = [];
      client.on('message', raw => { if (upstream.readyState === WebSocket.OPEN) upstream.send(raw.toString()); else queue.push(raw.toString()); });
      upstream.on('open', () => { for (const raw of queue) upstream.send(raw); queue.length = 0; });
      upstream.on('message', raw => { if (client.readyState === WebSocket.OPEN) client.send(raw.toString()); });
      upstream.on('close', () => { connections.delete(entry); if (client.readyState === WebSocket.OPEN) client.close(); });
      client.on('close', () => { connections.delete(entry); upstream.close(); });
      upstream.on('error', () => client.close()); client.on('error', () => upstream.close());
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const spkiHash = createHash('sha256').update(new X509Certificate(cert.cert).publicKey.export({ format: 'der', type: 'spki' })).digest('base64');
  return { origin: `https://127.0.0.1:${server.address().port}`, spkiHash, close: async () => {
    for (const { client, upstream } of connections) { client.terminate(); upstream.terminate(); }
    await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => server.close(resolve));
  } };
}

async function mediaProof(page, otherName, sender) {
  await page.getByRole('button', { name: `View ${otherName}`, exact: true }).click();
  await page.waitForFunction(() => { const video = document.getElementById('stage-video'); return !video.hidden && video.videoWidth > 0 && video.currentTime > 0 && video.readyState >= 2; });
  await page.waitForFunction(() => [...document.querySelectorAll('audio[data-peer]')].some(audio => audio.srcObject?.getAudioTracks().length && !audio.paused && !audio.muted));
  const audio = await page.evaluate(async () => {
    const audio = [...document.querySelectorAll('audio[data-peer]')].find(item => item.srcObject);
    const context = new AudioContext(); await context.resume(); const source = context.createMediaStreamSource(audio.srcObject);
    const analyser = context.createAnalyser(); analyser.fftSize = 512; source.connect(analyser); const samples = new Float32Array(512);
    let energy = 0;
    for (let i = 0; i < 15; i++) { await new Promise(resolve => setTimeout(resolve, 80)); analyser.getFloatTimeDomainData(samples); energy = Math.max(energy, samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length); }
    source.disconnect(); analyser.disconnect(); await context.close();
    return { decodedMeanSquareEnergy: energy, paused: audio.paused, muted: audio.muted, time: audio.currentTime };
  });
  assert.ok(audio.decodedMeanSquareEnergy > .000001, 'Relayed PCM must decode non-silent audio at the actual receiver output');
  assert.ok(await page.evaluate(() => qaPCs.every(pc => pc.connectionState === 'closed')), 'Direct RTC must be closed before media proof');
  const sourceBefore = sender ? await sender.evaluate(() => ({ time: performance.now(), paints: qaSourcePaints, encodes: qaEncodeRequests, encoded: qaEncodedFrames })) : null;
  const motion = await page.locator('#stage-video').evaluate(async video => {
    const before = video.getVideoPlaybackQuality().totalVideoFrames; const initialStream = video.srcObject; const initialTrack = initialStream.getVideoTracks()[0]; const initialTime = video.currentTime; const sourcePaintsBefore = qaSourcePaints; const encodesBefore = qaEncodeRequests; const encodedBefore = qaEncodedFrames; const decodedBefore = qaDecodedFrames; const start = performance.now();
    await new Promise(resolve => setTimeout(resolve, 3000));
    const frames = video.getVideoPlaybackQuality().totalVideoFrames - before; const seconds = (performance.now() - start) / 1000;
    return { width: video.videoWidth, height: video.videoHeight, time: video.currentTime, initialTime, sourcePaints: qaSourcePaints - sourcePaintsBefore, encodeRequests: qaEncodeRequests - encodesBefore, encodedOutputs: qaEncodedFrames - encodedBefore, decodedOutputs: qaDecodedFrames - decodedBefore, initialFrames: before, finalFrames: video.getVideoPlaybackQuality().totalVideoFrames, sameStream: video.srcObject === initialStream, sameTrack: video.srcObject?.getVideoTracks()[0] === initialTrack, decodedFrames: frames, measuredFps: frames / seconds };
  });
  if (sender) { const sourceAfter = await sender.evaluate(() => ({ time: performance.now(), paints: qaSourcePaints, encodes: qaEncodeRequests, encoded: qaEncodedFrames })); motion.source = { seconds: (sourceAfter.time - sourceBefore.time) / 1000, paints: sourceAfter.paints - sourceBefore.paints, encodes: sourceAfter.encodes - sourceBefore.encodes, encoded: sourceAfter.encoded - sourceBefore.encoded }; }
  assert.equal(motion.sameStream, true, 'Presentation stream must remain stable throughout quality proof: ' + JSON.stringify(motion));
  assert.equal(motion.sameTrack, true, 'Presentation track must remain stable throughout quality proof: ' + JSON.stringify(motion));
  assert.equal(motion.width, 2560, 'High-quality fallback must preserve the selected 1440p screen width');
  assert.equal(motion.height, 1440, 'High-quality fallback must preserve the selected 1440p screen height');
  assert.ok(motion.measuredFps > 15, 'High-quality fallback must display more than 15 actual frames per second over 3 seconds: ' + JSON.stringify(motion));
  return { video: motion, audio };
}

async function shareScreen(page) {
  if (await page.locator('#share-button').getAttribute('aria-label') === 'Stop sharing screen') return;
  await page.locator('#share-button').click(); await page.getByRole('button', { name: 'Synthetic full desktop', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('share-button').getAttribute('aria-label') === 'Stop sharing screen');
}

async function join(page, code) {
  await page.locator('.nav-item[data-view="rooms"]').click(); await page.locator('#quick-join-invite').fill(code); await page.locator('#quick-join-button').click();
  await page.waitForFunction(() => !document.getElementById('mic-button').disabled);
}
async function rejectedJoin(page, code) {
  await page.locator('.nav-item[data-view="rooms"]').click(); await page.locator('#quick-join-invite').fill(code); await page.locator('#quick-join-button').click();
  await page.waitForFunction(() => document.getElementById('host-button').disabled === false);
  assert.equal(await page.locator('#session').isVisible(), false);
  assert.equal(await page.locator('#mic-button').isDisabled(), true);
}

async function main() {
  let runtime, proxy, browser; const errors = []; let phase = 'setup'; const proof = {};
  fs.mkdirSync(output, { recursive: true });
  try {
    const { createLocalCoordinator } = await import(pathToFileURL(path.join(root, 'internet-service/tests/local-runtime.mjs')).href);
    runtime = live ? null : await createLocalCoordinator({ bindings: { PUBLIC_ROOMS: 'true', WEBSOCKET_RELAY: 'true' } });
    proxy = await localHTTPS(runtime || { url: 'https://auralink-private-coordinator.auralink-internet-service.workers.dev' });
    browser = await chromium.launch({ executablePath: browserPath, headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-features=WebRtcHideLocalIpsWithMdns', `--ignore-certificate-errors-spki-list=${proxy.spkiHash}`] });
    proof.browser = { executable: path.basename(browserPath), version: browser.version() };
    const contexts = [];
    for (const [width, height, phone] of [[1380, 940, false], [1380, 940, false], [1380, 940, false]]) {
      const context = await browser.newContext({ viewport: { width, height }, isMobile: phone, hasTouch: phone, permissions: ['microphone'] }); contexts.push(context);
      await context.addInitScript(({ origin, phone }) => {
        if (!localStorage.getItem('auralink.preferences')) localStorage.setItem('auralink.preferences', JSON.stringify({ name: 'My device', quality: '1440' }));
        window.qaSentTypes = []; window.qaCipherCount = 0; window.qaCipherViolation = false; window.qaCaptureCalls = []; window.qaStreams = []; window.qaPCs = []; window.qaTrustCalls = []; window.qaGrants = []; window.qaCopies = []; window.qaRoutes = [];
        const NativeSocket = window.WebSocket;
        window.WebSocket = new Proxy(NativeSocket, { construct(target, args) {
          const requested = new URL(args[0]); if (requested.protocol !== 'wss:' || requested.pathname !== '/internet/ws') throw new Error('Unexpected QA socket target');
          const mapped = origin.replace(/^https:/, 'wss:') + '/internet/ws'; const socket = Reflect.construct(target, [mapped]);
          const send = socket.send.bind(socket); socket.send = raw => {
            const packet = JSON.parse(raw); qaSentTypes.push(packet.type);
            if (packet.data?.relay) { qaCipherCount++; const envelope = packet.data.relay;
              if (Object.keys(packet.data).join(',') !== 'relay' || Object.keys(envelope).sort().join(',') !== 'ciphertext,counter,epoch,nonce,version' || !/^[A-Za-z0-9_-]+$/.test(envelope.ciphertext)) qaCipherViolation = true;
            }
            return send(raw);
          }; return socket;
        } });
        window.qaSourcePaints = 0; window.qaEncodeRequests = 0; window.qaEncodedFrames = 0; window.qaDecodedFrames = 0;
        if (typeof VideoEncoder === 'function') { const NativeEncoder = VideoEncoder; window.VideoEncoder = new Proxy(NativeEncoder, { construct(target, args) { const options = args[0]; const encoder = Reflect.construct(target, [{ ...options, output: (...values) => { qaEncodedFrames++; return options.output(...values); } }]); const encode = encoder.encode.bind(encoder); encoder.encode = (...values) => { qaEncodeRequests++; return encode(...values); }; return encoder; } }); }
        if (typeof VideoDecoder === 'function') { const NativeDecoder = VideoDecoder; window.VideoDecoder = new Proxy(NativeDecoder, { construct(target, args) { const options = args[0]; return Reflect.construct(target, [{ ...options, output: (...values) => { qaDecodedFrames++; return options.output(...values); } }]); } }); }
        const NativeRTC = window.RTCPeerConnection; window.RTCPeerConnection = new Proxy(NativeRTC, { construct(target, args) { const pc = Reflect.construct(target, [{ ...args[0], iceServers: [], iceTransportPolicy: 'relay' }]); qaPCs.push(pc); return pc; } });
        const nativeCapture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async config => { if (config.video) throw new Error('Camera capture is outside the screen/audio product'); qaCaptureCalls.push('microphone'); const stream = await nativeCapture(config); qaStreams.push(stream); return stream; };
        navigator.mediaDevices.getDisplayMedia = async () => {
          qaCaptureCalls.push('screen');
          const canvas = new OffscreenCanvas(2560, 1440); const context = canvas.getContext('2d'); const track = new MediaStreamTrackGenerator({ kind: 'video' }); const writer = track.writable.getWriter();
          let frame = 0, pending = false; const started = performance.now();
          const paint = async () => {
            if (pending || track.readyState !== 'live') return; pending = true; qaSourcePaints++;
            context.fillStyle = '#102737'; context.fillRect(0, 0, 2560, 1440); context.fillStyle = '#a8f4d4'; context.fillRect(100 + frame * 18 % 2000, 250, 360, 340); context.fillStyle = '#eef9ff'; context.font = '52px sans-serif'; context.fillText('2560 × 1440 generated screen · frame ' + frame++, 90, 120);
            const videoFrame = new VideoFrame(canvas, { timestamp: Math.round((performance.now() - started) * 1000) });
            try { await writer.write(videoFrame); } catch {} finally { videoFrame.close(); pending = false; }
          };
          await paint(); const timer = setInterval(paint, 1000 / 30);
          const stop = track.stop.bind(track); track.stop = () => { clearInterval(timer); void writer.abort().catch(() => {}); stop(); };
          const stream = new MediaStream([track]); qaStreams.push(stream); return stream;
        };
        window.auralink = { platform: 'qa-desktop', getInfo: async () => ({ platform: phone ? 'Responsive desktop fixture' : 'Desktop fixture' }), trustInternetService: async address => { qaTrustCalls.push(address); }, requestMedia: async () => ({ ok: true }), copyText: async value => { qaCopies.push(value); }, sources: async () => [{ id: 'screen:qa', name: 'Synthetic full desktop' }], chooseScreen: async () => {}, grantControl: async value => { qaGrants.push(value); return { ok: true }; }, revokeControl: async () => {}, applyInput: async () => {}, setAudioRoute: async route => { qaRoutes.push(route); }, stopSharing: async () => {} };
      }, { origin: proxy.origin, phone });
    }
    const host = await contexts[0].newPage(); const guest = await contexts[1].newPage(); const outsider = await contexts[2].newPage();
    for (const page of [host, guest, outsider]) { page.on('pageerror', error => errors.push(`${phase}: ${error.message}`)); await page.goto(proxy.origin); }
    await host.locator('#quick-name').fill('Invitation host'); await guest.locator('#quick-name').fill('Invitation guest'); await outsider.locator('#quick-name').fill('Fresh identity');
    phase = 'single-click creation'; await host.locator('#host-button').click(); await host.waitForFunction(() => !document.getElementById('mic-button').disabled);
    assert.equal(await host.locator('#host-dialog').evaluate(dialog => dialog.open), false); assert.equal(await host.locator('#invite-dialog').evaluate(dialog => dialog.open), false);
    assert.equal(await host.locator('#room-invitation-bar').isVisible(), true);
    const firstCode = await host.locator('#room-code').inputValue(); assert.match(firstCode, /^A1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/i);
    assert.deepEqual(await host.evaluate(() => qaSentTypes.slice(0, 3)), ['bootstrap', 'create-room', 'join']);
    assert.deepEqual(await host.evaluate(() => qaCaptureCalls), []);
    assert.equal(await host.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('auralink.internet.identity:')).length), 0);
    proof.oneClickRoomWithoutPairingOrCapture = true;
    phase = 'automatic invitation admission'; await join(guest, firstCode);
    assert.equal(await host.locator('#pending-banner').isVisible(), false); assert.deepEqual(await guest.evaluate(() => qaCaptureCalls), []);
    assert.ok(!(await host.evaluate(() => qaSentTypes)).includes('approve')); assert.ok(!(await guest.evaluate(() => qaSentTypes)).includes('pair'));
    proof.invitationJoinsWithoutOwnerAdmission = true;
    // No screenshot of live room capability is written into public evidence.
    phase = 'bidirectional microphone and host screen'; for (const page of [host, guest]) { await page.locator('#mic-button').click(); assert.equal(await page.locator('#camera-button').count(), 0); }
    proof.screenAndMicrophoneOnly = true;
    await shareScreen(host); proof.guestReceiver = await mediaProof(guest, 'Invitation host', host);
    const codecProof = async page => { await page.locator('#diagnostics-toggle').click(); await page.waitForFunction(() => document.getElementById('diagnostics').textContent.includes('Secure relay')); const codecText = await page.locator('#diagnostics').innerText(); assert.match(codecText, /AVC|VP8|H\.264|avc1/i, 'Diagnostics must name the actual encoded screen codec'); await page.locator('#diagnostics-close').click(); return codecText.match(/AVC|VP8|H\.264|avc1/i)[0]; };
    proof.guestCodec = await codecProof(guest);
    phase = 'reverse direction high-quality screen'; await host.locator('#share-button').click(); await guest.waitForFunction(() => document.getElementById('stage-video').hidden);
    await shareScreen(guest); proof.hostReceiver = await mediaProof(host, 'Invitation guest', guest); proof.hostCodec = await codecProof(host);
    await guest.locator('#share-button').click(); await host.waitForFunction(() => document.getElementById('stage-video').hidden);
    phase = 'restore host screen'; await shareScreen(host); await guest.waitForFunction(() => document.getElementById('stage-video').videoWidth > 0 && !document.getElementById('stage-video').hidden);
    for (const page of [host, guest]) assert.ok(await page.evaluate(() => qaCipherCount > 10 && !qaCipherViolation), 'All forwarded fallback media must be strict ciphertext envelopes');
    proof.directRTCImpossibleAndClosed = true; proof.ciphertextOnlyMediaTransport = true;
    phase = 'relay microphone mute and restart'; await host.locator('#mic-button').click();
    await guest.waitForFunction(() => ![...document.querySelectorAll('audio[data-peer]')].some(audio => audio.srcObject));
    await host.locator('#mic-button').click(); proof.restartedAudio = (await mediaProof(guest, 'Invitation host', host)).audio;
    assert.ok(await guest.evaluate(() => qaRoutes.some(route => route.ongoing === true)), 'Audio bridge requests continuity after actual media is active');
    phase = 'lock keeps admitted people and blocks old capability'; await host.locator('#lock-room-button').click(); await host.waitForFunction(() => document.getElementById('room-code').value === 'Invitation closed');
    assert.equal(await guest.locator('#mic-button').isDisabled(), false); await rejectedJoin(outsider, firstCode); proof.lockDoesNotRemoveExistingParticipants = true;
    phase = 'rotate invitation'; await host.locator('#rotate-room-invite').click(); await host.waitForFunction(old => document.getElementById('room-code').value !== old && document.getElementById('room-code').value.startsWith('A1.'), firstCode);
    const secondCode = await host.locator('#room-code').inputValue(); assert.notEqual(secondCode, firstCode); await rejectedJoin(outsider, firstCode); proof.rotationInvalidatesOldCode = true;
    phase = 'host remove allows explicit rejoin until closed'; await host.locator('#room-people-button').click();
    const guestCard = host.locator('#device-list .device-card').filter({ has: host.getByRole('heading', { name: 'Invitation guest', exact: true }) });
    await guestCard.getByRole('button', { name: 'Remove', exact: true }).click(); await guest.waitForFunction(() => document.getElementById('host-button').disabled === false);
    assert.equal(await guest.evaluate(() => qaStreams.some(stream => stream.getTracks().some(track => track.readyState === 'live'))), false);
    await join(guest, secondCode); proof.removalStopsCaptureAndAllowsCurrentInvitationRejoin = true;
    phase = 'block burns invite, including for a fresh anonymous identity'; await guestCard.getByRole('button', { name: 'Remove & close invite', exact: true }).click();
    await guest.waitForFunction(() => document.getElementById('host-button').disabled === false); await rejectedJoin(guest, secondCode); await rejectedJoin(outsider, secondCode);
    assert.equal(await host.locator('#room-code').inputValue(), 'Invitation closed'); proof.blockBurnsCapabilityRatherThanClaimingPermanentIdentityBan = true;
    phase = 'control is still a separate consent'; await host.locator('.nav-item[data-view="rooms"]').click(); await host.locator('#rotate-room-invite').click(); await host.waitForFunction(() => document.getElementById('room-code').value.startsWith('A1.'));
    const thirdCode = await host.locator('#room-code').inputValue(); await rejectedJoin(guest, thirdCode); proof.blockedCurrentConnectionCannotUseRotatedCode = true;
    // Public identities are deliberately ephemeral. A newly opened app has a
    // new identity and may enter with a newly shared capability, never the old one.
    await guest.reload(); await join(guest, thirdCode); await host.locator('.nav-item[data-view="rooms"]').click(); await shareScreen(host);
    await guest.waitForFunction(() => !document.getElementById('request-control').disabled); await guest.locator('#request-control').click(); await host.waitForFunction(() => document.getElementById('control-dialog').open);
    assert.deepEqual(await host.evaluate(() => qaGrants), []); await host.locator('#deny-control').click(); await guest.waitForFunction(() => document.getElementById('request-control').querySelector('small').textContent === 'Request control');
    await guest.locator('#request-control').click(); await host.waitForFunction(() => document.getElementById('control-dialog').open); await host.locator('#allow-control').click(); await guest.waitForFunction(() => !document.getElementById('control-banner').hidden);
    assert.equal(await host.evaluate(() => qaGrants.length), 1); proof.autoEntryDoesNotAuthorizeScreenCaptureOrRemoteControl = true;
    phase = 'teardown'; await guest.locator('#end-button').click(); await guest.waitForFunction(() => document.getElementById('host-button').disabled === false); await host.locator('#end-button').click(); await host.waitForFunction(() => document.getElementById('host-button').disabled === false);
    for (const page of [host, guest, outsider]) {
      assert.equal(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('auralink.internet.identity:')).length), 0);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    }
    assert.deepEqual(errors, []); proof.status = 'passed'; proof.coordinator = live ? 'Deployed public Cloudflare Worker via PKI-verified WSS' : 'Local workerd via TLS fixture';
    proof.boundary = 'Actual renderer and TLS WebSocket; real RTC restricted to relay-only with no TURN. Synthetic microphone and OffscreenCanvas→generatedVideoFrame screen and native consent fixture. This measures one presenter at a time in both directions plus bidirectional voice over blocked-P2P fallback on two same-PC clients, not physical Mac audio/capture/input or different carriers/countries.';
    proof.sourceHashes = Object.fromEntries(['src/renderer/app.js', 'src/renderer/rtc.js', 'src/renderer/relay-media.js', 'src/renderer/audio-worklet.js', 'src/renderer/internet.js'].map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
    fs.writeFileSync(path.join(output, live ? 'websocket-relay-live.json' : 'websocket-relay-browser.json'), JSON.stringify(proof, null, 2)); console.log(JSON.stringify(proof, null, 2));
  } catch (error) {
    fs.writeFileSync(path.join(output, live ? 'websocket-relay-live.json' : 'websocket-relay-browser.json'), JSON.stringify({ ...proof, status: 'failed', phase, error: error.message, pageErrors: errors }, null, 2)); throw error;
  } finally { await browser?.close(); await proxy?.close(); await runtime?.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
