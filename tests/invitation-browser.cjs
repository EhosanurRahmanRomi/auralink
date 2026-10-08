'use strict';

// Actual bundled renderer, local workerd capability protocol and real Chromium
// WebRTC. The public-origin socket is mapped to a local TLS coordinator fixture;
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

async function mediaProof(page, otherName) {
  const before = await page.evaluate(async () => Object.fromEntries((await Promise.all(qaPCs.map(async pc => [...(await pc.getStats()).values()].filter(row => row.type === 'inbound-rtp' && row.kind === 'audio').map(row => [row.trackIdentifier, row.totalAudioEnergy || 0])))).flat()));
  await page.getByRole('button', { name: `View ${otherName}`, exact: true }).click();
  await page.waitForFunction(() => { const video = document.getElementById('stage-video'); return !video.hidden && video.videoWidth > 0 && video.currentTime > 0 && video.readyState >= 2; });
  let rows; const deadline = Date.now() + 20000;
  do {
    rows = await page.evaluate(async before => (await Promise.all(qaPCs.map(async pc => [...(await pc.getStats()).values()].filter(row => row.type === 'inbound-rtp' && row.kind === 'audio').map(row => ({ packets: row.packetsReceived, energy: row.totalAudioEnergy - (before[row.trackIdentifier] || 0), muted: pc.getReceivers().find(receiver => receiver.track.id === row.trackIdentifier)?.track.muted }))))).flat(), before);
    if (rows.some(row => row.packets > 10 && row.energy > .00001 && row.muted === false)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert.ok(rows.some(row => row.energy > .00001 && row.muted === false), 'Real incoming microphone must decode new audio on an unmuted receiver');
  return { video: await page.locator('#stage-video').evaluate(video => ({ width: video.videoWidth, height: video.videoHeight, time: video.currentTime })), audio: rows };
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
    runtime = await createLocalCoordinator({ bindings: { PUBLIC_ROOMS: 'true' } }); proxy = await localHTTPS(runtime);
    browser = await chromium.launch({ executablePath: browserPath, headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-features=WebRtcHideLocalIpsWithMdns', `--ignore-certificate-errors-spki-list=${proxy.spkiHash}`] });
    proof.browser = { executable: path.basename(browserPath), version: browser.version() };
    const contexts = [];
    for (const [width, height, phone] of [[1380, 940, false], [412, 915, true], [412, 915, true]]) {
      const context = await browser.newContext({ viewport: { width, height }, isMobile: phone, hasTouch: phone, permissions: ['microphone'] }); contexts.push(context);
      await context.addInitScript(({ origin, phone }) => {
        if (!localStorage.getItem('auralink.preferences')) localStorage.setItem('auralink.preferences', JSON.stringify({ name: 'My device', quality: '1440' }));
        window.qaSentTypes = []; window.qaCaptureCalls = []; window.qaStreams = []; window.qaPCs = []; window.qaTrustCalls = []; window.qaGrants = []; window.qaCopies = []; window.qaRoutes = [];
        window.qaHoldTrust = false; window.qaInvitationListeners = new Set();
        window.qaDeliverInvitation = code => { for (const listener of qaInvitationListeners) listener(code); };
        const NativeSocket = window.WebSocket;
        window.WebSocket = new Proxy(NativeSocket, { construct(target, args) {
          const requested = new URL(args[0]); if (requested.protocol !== 'wss:' || requested.pathname !== '/internet/ws') throw new Error('Unexpected QA socket target');
          const mapped = origin.replace(/^https:/, 'wss:') + '/internet/ws'; const socket = Reflect.construct(target, [mapped]);
          const send = socket.send.bind(socket); socket.send = raw => { qaSentTypes.push(JSON.parse(raw).type); return send(raw); }; return socket;
        } });
        const NativeRTC = window.RTCPeerConnection; window.RTCPeerConnection = new Proxy(NativeRTC, { construct(target, args) { const pc = Reflect.construct(target, args); qaPCs.push(pc); return pc; } });
        const nativeCapture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async config => { if (config.video) throw new Error('Camera capture is outside the screen/audio product'); qaCaptureCalls.push('microphone'); const stream = await nativeCapture(config); qaStreams.push(stream); return stream; };
        navigator.mediaDevices.getDisplayMedia = async () => {
          qaCaptureCalls.push('screen'); const canvas = document.createElement('canvas'); canvas.width = 2560; canvas.height = 1440; const context = canvas.getContext('2d');
          window.qaSourcePaints = 0; let frame = 0; const paint = () => { qaSourcePaints++; context.fillStyle = '#102737'; context.fillRect(0, 0, canvas.width, canvas.height); context.fillStyle = '#a8f4d4'; context.fillRect(100 + frame * 18 % 2000, 250, 360, 340); context.fillStyle = '#eef9ff'; context.font = '52px sans-serif'; context.fillText('2560 × 1440 shared desktop · frame ' + frame++, 90, 120); }; paint(); const timer = setInterval(paint, 1000 / 30);
          const stream = canvas.captureStream(30); stream.getVideoTracks()[0].addEventListener('ended', () => clearInterval(timer)); qaStreams.push(stream); return stream;
        };
        window.auralink = { platform: 'qa-desktop', getInfo: async () => ({ platform: phone ? 'Responsive desktop fixture' : 'Desktop fixture' }), trustInternetService: async address => { qaTrustCalls.push(address); if (qaHoldTrust) await new Promise(resolve => { window.qaReleaseTrust = () => { qaHoldTrust = false; resolve(); }; }); }, requestMedia: async () => ({ ok: true }), copyText: async value => { qaCopies.push(value); }, sources: async () => [{ id: 'screen:qa', name: 'Synthetic full desktop' }], chooseScreen: async () => {}, grantControl: async value => { qaGrants.push(value); return { ok: true }; }, revokeControl: async () => {}, applyInput: async () => {}, setAudioRoute: async route => { qaRoutes.push(route); }, stopSharing: async () => {}, onEmergencyStop: listener => { window.qaEmergencyStop = listener; return () => { window.qaEmergencyStop = null; }; }, onInvitation: listener => { qaInvitationListeners.add(listener); return () => qaInvitationListeners.delete(listener); }, getPendingInvitation: async () => { const code = sessionStorage.getItem('qa.pendingInvitation'); sessionStorage.removeItem('qa.pendingInvitation'); if (sessionStorage.getItem('qa.duplicateInvitation')) { sessionStorage.removeItem('qa.duplicateInvitation'); qaDeliverInvitation(code); } return code; } };
      }, { origin: proxy.origin, phone });
    }
    const host = await contexts[0].newPage(); const guest = await contexts[1].newPage(); const outsider = await contexts[2].newPage();
    for (const page of [host, guest, outsider]) { page.on('pageerror', error => errors.push(`${phase}: ${error.message}`)); await page.goto(proxy.origin); }
    await host.locator('#quick-name').fill('Invitation host'); await guest.locator('#quick-name').fill('Invitation phone'); await outsider.locator('#quick-name').fill('Fresh identity');
    await guest.locator('#quick-name').blur();
    for (const [page, name] of [[host, 'invitation-lobby-desktop.png'], [guest, 'invitation-lobby-phone.png']]) {
      await page.screenshot({ path: path.join(output, name), fullPage: true });
      assert.equal(await page.locator('#host-button').isVisible(), true);
      assert.equal(await page.locator('#quick-join-form').isVisible(), true);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    }
    phase = 'cancel before native trust returns'; await host.evaluate(() => { qaHoldTrust = true; }); await host.locator('#host-button').click();
    await host.waitForFunction(() => typeof qaReleaseTrust === 'function'); await host.locator('#cancel-room-start').click();
    await host.waitForFunction(() => !document.getElementById('host-button').disabled); await host.evaluate(() => qaReleaseTrust());
    assert.deepEqual(await host.evaluate(() => qaSentTypes), [], 'Canceled native transport verification cannot bootstrap or create a stale room');
    assert.deepEqual(await host.evaluate(() => qaCaptureCalls), []); proof.cancellationBeforeTrustCannotOpenRoom = true;
    phase = 'single-click creation'; await host.locator('#host-button').click(); await host.waitForFunction(() => !document.getElementById('mic-button').disabled);
    assert.equal(await host.locator('#host-dialog').evaluate(dialog => dialog.open), false); assert.equal(await host.locator('#invite-dialog').evaluate(dialog => dialog.open), false);
    assert.equal(await host.locator('#room-invitation-bar').isVisible(), true);
    const firstCode = await host.locator('#room-code').inputValue(); assert.match(firstCode, /^A1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/i);
    assert.deepEqual(await host.evaluate(() => qaSentTypes.slice(0, 3)), ['bootstrap', 'create-room', 'join']);
    assert.deepEqual(await host.evaluate(() => qaCaptureCalls), []);
    assert.equal(await host.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('auralink.internet.identity:')).length), 0);
    proof.oneClickRoomWithoutPairingOrCapture = true;
    phase = 'startup native invitation admission'; await guest.evaluate(code => {
      sessionStorage.setItem('qa.pendingInvitation', code); sessionStorage.setItem('qa.duplicateInvitation', '1');
      const service = 'https://auralink-private-coordinator.auralink-internet-service.workers.dev';
      localStorage.setItem(`auralink.internet.identity:${service}`, JSON.stringify({ deviceId: 'saved-private-device', deviceToken: 'saved-private-token-never-sent' }));
      localStorage.setItem('auralink.preferences', JSON.stringify({ ...JSON.parse(localStorage.getItem('auralink.preferences')), internetOrigin: service, internetOnline: true }));
    }, firstCode); await guest.reload();
    await guest.waitForFunction(() => !document.getElementById('mic-button').disabled);
    assert.equal(await guest.locator('#incoming-invite-banner').isVisible(), false, 'The same startup/live invitation is consumed once');
    assert.equal(await guest.evaluate(() => sessionStorage.getItem('qa.pendingInvitation')), null);
    assert.deepEqual(await guest.evaluate(() => qaSentTypes.slice(0, 2)), ['bootstrap', 'join'], 'An OS invitation takes priority over restoring a private directory');
    assert.equal(await guest.evaluate(() => JSON.parse(localStorage.getItem('auralink.internet.identity:https://auralink-private-coordinator.auralink-internet-service.workers.dev')).deviceToken), 'saved-private-token-never-sent');
    await guest.evaluate(() => { localStorage.removeItem('auralink.internet.identity:https://auralink-private-coordinator.auralink-internet-service.workers.dev'); localStorage.setItem('auralink.preferences', JSON.stringify({ ...JSON.parse(localStorage.getItem('auralink.preferences')), internetOnline: false })); });
    assert.equal(await host.locator('#pending-banner').isVisible(), false); assert.deepEqual(await guest.evaluate(() => qaCaptureCalls), []);
    assert.ok(!(await host.evaluate(() => qaSentTypes)).includes('approve')); assert.ok(!(await guest.evaluate(() => qaSentTypes)).includes('pair'));
    proof.invitationJoinsWithoutOwnerAdmission = true;
    proof.startupNativeLinkJoinsOnceWithoutAdditionalForm = true;
    phase = 'warm native invitation retains current room'; const differentCode = `A1.89bf3734-2920-41c1-bbce-439085f9037e.${'A'.repeat(43)}`;
    const beforeWarmLink = await host.evaluate(() => qaSentTypes.slice()); await host.evaluate(code => qaDeliverInvitation(code), differentCode);
    assert.equal(await host.locator('#incoming-invite-banner').isVisible(), true); assert.equal(await host.locator('#quick-join-invite').inputValue(), differentCode);
    assert.deepEqual(await host.evaluate(() => qaSentTypes), beforeWarmLink); assert.equal(await host.locator('#room-code').inputValue(), firstCode);
    assert.equal(await host.locator('#mic-button').isDisabled(), false); await host.locator('#dismiss-incoming-invite').click(); proof.warmNativeLinkDoesNotDisconnectOrCapture = true;
    for (const [page, name] of [[host, 'invitation-room-desktop.png'], [guest, 'invitation-room-phone.png']]) await page.screenshot({ path: path.join(output, name), fullPage: true });
    phase = 'real microphone and screen media'; for (const page of [host, guest]) { await page.locator('#mic-button').click(); await shareScreen(page); assert.equal(await page.locator('#camera-button').count(), 0); }
    proof.screenAndMicrophoneOnly = true;
    proof.hostReceiver = await mediaProof(host, 'Invitation phone'); proof.guestReceiver = await mediaProof(guest, 'Invitation host');
    await host.locator('#diagnostics-toggle').click(); await host.locator('#copy-diagnostics').click();
    const copiedDetails = await host.evaluate(() => qaCopies.at(-1)); assert.ok(copiedDetails.includes('connections')); assert.ok(!copiedDetails.includes(firstCode.split('.').at(-1))); assert.ok(!copiedDetails.includes('Invitation phone')); await host.locator('#diagnostics-close').click(); proof.copiedDiagnosticsOmitCapabilitiesAndNames = true;
    assert.ok(await guest.evaluate(() => qaRoutes.some(route => route.ongoing === true)), 'Audio bridge requests continuity after actual media is active');
    phase = 'lock keeps admitted people and blocks old capability'; await host.locator('#lock-room-button').click(); await host.waitForFunction(() => document.getElementById('room-code').value === 'Invitation closed');
    assert.equal(await guest.locator('#mic-button').isDisabled(), false); await rejectedJoin(outsider, firstCode); proof.lockDoesNotRemoveExistingParticipants = true;
    phase = 'rotate invitation'; await host.locator('#rotate-room-invite').click(); await host.waitForFunction(old => document.getElementById('room-code').value !== old && document.getElementById('room-code').value.startsWith('A1.'), firstCode);
    const secondCode = await host.locator('#room-code').inputValue(); assert.notEqual(secondCode, firstCode); await rejectedJoin(outsider, firstCode); proof.rotationInvalidatesOldCode = true;
    phase = 'host remove allows explicit rejoin until closed'; await host.locator('#room-people-button').click();
    const guestCard = host.locator('#device-list .device-card').filter({ has: host.getByRole('heading', { name: 'Invitation phone', exact: true }) });
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
    phase = 'display layout change invalidates presentation and consent'; await host.evaluate(() => qaEmergencyStop('Display layout changed. Select a screen and approve control again.'));
    await host.waitForFunction(() => document.getElementById('share-button').getAttribute('aria-label') === 'Share screen'); await guest.waitForFunction(() => document.getElementById('stage-video').hidden && document.getElementById('control-banner').hidden);
    assert.equal(await host.locator('#control-banner').isVisible(), false); proof.nativeDisplayLayoutChangeStopsCaptureAndControl = true;
    await shareScreen(host); await guest.waitForFunction(() => !document.getElementById('request-control').disabled); await guest.locator('#request-control').click(); await host.waitForFunction(() => document.getElementById('control-dialog').open);
    assert.equal(await host.evaluate(() => qaGrants.length), 1, 'Reselected display cannot inherit old consent'); await host.locator('#allow-control').click(); await guest.waitForFunction(() => !document.getElementById('control-banner').hidden);
    assert.equal(await host.evaluate(() => qaGrants.length), 2); proof.changedDisplayRequiresReselectionAndNewConsent = true;
    phase = 'teardown'; await guest.locator('#end-button').click(); await guest.waitForFunction(() => document.getElementById('host-button').disabled === false); await host.locator('#end-button').click(); await host.waitForFunction(() => document.getElementById('host-button').disabled === false);
    for (const page of [host, guest, outsider]) {
      assert.equal(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('auralink.internet.identity:')).length), 0);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    }
    assert.deepEqual(errors, []); proof.status = 'passed'; proof.boundary = 'Local workerd/TLS fixture remaps the public-origin socket. Real same-PC Chromium WebRTC, synthetic media/native permission fixtures. No cross-network relay or physical Android proof.';
    proof.sourceHashes = Object.fromEntries(['src/renderer/app.js', 'src/renderer/rtc.js', 'src/renderer/relay-media.js', 'src/renderer/audio-worklet.js', 'src/renderer/internet.js'].map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
    fs.writeFileSync(path.join(output, 'invitation-browser.json'), JSON.stringify(proof, null, 2)); console.log(JSON.stringify(proof, null, 2));
  } catch (error) {
    fs.writeFileSync(path.join(output, 'invitation-browser.json'), JSON.stringify({ ...proof, status: 'failed', phase, error: error.message, pageErrors: errors }, null, 2)); throw error;
  } finally { await browser?.close(); await proxy?.close(); await runtime?.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
