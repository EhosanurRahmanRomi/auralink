'use strict';

// Renderer integration of the native projection contract. JPEG frames and native
// approval/input are explicit fixtures. RTP decode and broker consent are real.
// This cannot establish MediaProjection or Accessibility behavior on a phone.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');
const selfsigned = require('selfsigned');
const { chromium } = require('playwright');
const { createBroker } = require('../src/core/broker.cjs');
const { fingerprint } = require('../src/core/invite.cjs');
const browserPath = [process.env.AURALINK_TEST_BROWSER, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/chromium', '/usr/bin/google-chrome'].filter(Boolean).find(file => fs.existsSync(file));
if (!browserPath) throw new Error('Install Edge/Chrome or set AURALINK_TEST_BROWSER.');

async function hostFixture(broker, getPhase, reportError) {
  const ws = new WebSocket(broker.url.replace(/^http/, 'ws') + '/ws', { rejectUnauthorized: false });
  const host = { ws, page: null, ready: false, stopping: false, inbox: [], waiters: [], signals: [], chain: Promise.resolve() };
  host.send = packet => {
    if (host.stopping) return false;
    if (ws.readyState !== WebSocket.OPEN) { reportError(`${getPhase()}: fixture socket closed before signaling completed`); return false; }
    ws.send(JSON.stringify(packet), error => { if (error) reportError(`${getPhase()}: fixture send failed: ${error.message}`); });
    return true;
  };
  host.take = type => {
    const index = host.inbox.findIndex(packet => packet.type === type);
    if (index >= 0) return Promise.resolve(host.inbox.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { type, resolve }; waiter.timer = setTimeout(() => reject(new Error(`No ${type} received`)), 10000); host.waiters.push(waiter);
    });
  };
  host.deliver = packet => {
    if (host.stopping) return;
    const queuedPhase = getPhase();
    host.chain = host.chain.then(() => host.page.evaluate(packet => rtc.receive(packet.from, packet.data), packet))
      .catch(error => { reportError(`${queuedPhase}: fixture signal delivery failed: ${error.message}`); });
  };
  const receive = raw => {
    const packet = JSON.parse(raw.toString());
    if (packet.type === 'signal') { if (host.ready) host.deliver(packet); else host.signals.push(packet); return; }
    const index = host.waiters.findIndex(waiter => waiter.type === packet.type);
    if (index >= 0) { const waiter = host.waiters.splice(index, 1)[0]; clearTimeout(waiter.timer); waiter.resolve(packet); }
    else host.inbox.push(packet);
  };
  ws.on('message', receive);
  ws.on('error', error => { if (!host.stopping) reportError(`${getPhase()}: fixture socket failed: ${error.message}`); });
  host.stop = async () => {
    host.stopping = true; host.ready = false; host.signals.length = 0;
    ws.off('message', receive);
    for (const waiter of host.waiters) clearTimeout(waiter.timer);
    host.waiters.length = 0;
    if (ws.readyState !== WebSocket.CLOSED) await new Promise(resolve => { ws.once('close', resolve); ws.terminate(); });
    await host.chain;
  };
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  host.send({ type: 'join', name: 'Desktop controller fixture', roomKey: broker.roomKey, hostToken: broker.hostToken }); host.id = (await host.take('welcome')).selfId; return host;
}

async function main() {
  const output = path.resolve(__dirname, '..', 'test-results'); fs.mkdirSync(output, { recursive: true });
  let broker; let browser; let host; let phone; let result; let failure; let phase = 'setup'; const errors = []; const contexts = [];
  const reportError = message => { errors.push(message); console.error(message); };
  try {
    const cert = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], { keySize: 2048, algorithm: 'sha256' });
    broker = await createBroker({ host: '127.0.0.1', name: 'Phone screen QA', tls: { key: cert.private, cert: cert.cert }, assetsDir: path.resolve(__dirname, '..', 'src', 'renderer') });
    host = await hostFixture(broker, () => phase, reportError);
    browser = await chromium.launch({ executablePath: browserPath, headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
    const desktop = await browser.newContext({ ignoreHTTPSErrors: true });
    const mobile = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true }); contexts.push(desktop, mobile);
    await mobile.addInitScript(() => {
      // Reproduce unavailable compositor capture independently of the native
      // bridge fixture. Phone streaming must use explicit generated frames.
      HTMLCanvasElement.prototype.captureStream = () => { throw new Error('Canvas capture is unavailable in this background regression'); };
      Image.prototype.decode = () => Promise.reject(new Error('DOM image decode is unavailable in this background regression'));
      const fixture = window.qaPhone = { started: 0, stops: 0, sequence: 0, acked: [], inputs: [], routes: [], grant: null, timer: null, frame: null, stop: null, emergency: null };
      const canvas = document.createElement('canvas'); canvas.width = 720; canvas.height = 1280; const draw = canvas.getContext('2d');
      window.glancePort = Object.freeze({ platform: 'android',
        getInfo: async () => ({ platform: 'Android fixture', capabilities: { screenShare: true, remoteInputHost: true }, accessibilityEnabled: true }),
        setAudioRoute: async route => { fixture.routes.push(route); return { ok: true }; },
        startScreenShare: async options => {
          fixture.started++; fixture.options = options;
          fixture.timer = setInterval(() => {
            if (!fixture.frame) return;
            draw.fillStyle = '#102837'; draw.fillRect(0, 0, 720, 1280);
            draw.fillStyle = '#91f2d5'; draw.font = '35px sans-serif'; draw.fillText('Synthetic Android projection', 30, 80);
            draw.fillStyle = '#7b9ad6'; draw.fillRect(40, 180 + fixture.sequence % 12 * 15, 640, 180);
            fixture.frame({ seq: ++fixture.sequence, data: canvas.toDataURL('image/jpeg', .7), width: 720, height: 1280 });
          }, 100);
          return { id: 'android-screen', name: 'Phone display', width: 720, height: 1280, fps: 12, maxEdge: 1280 };
        },
        stopScreenShare: async () => { fixture.stops++; clearInterval(fixture.timer); fixture.timer = null; return { ok: true }; },
        stopSharing: async () => ({ ok: true }),
        onScreenFrame: listener => { fixture.frame = listener; return () => { fixture.frame = null; }; },
        onScreenStopped: listener => { fixture.stop = listener; return () => {}; },
        ackScreenFrame: async packet => { fixture.acked.push(packet.seq); return { ok: true }; },
        grantControl: async request => { fixture.grant = request; return { ok: true }; },
        revokeControl: async () => { fixture.grant = null; return { ok: true }; },
        applyInput: async packet => { fixture.inputs.push(packet); return { ok: true }; },
        onEmergencyStop: listener => { fixture.emergency = listener; return () => {}; },
      });
    });
    host.page = await desktop.newPage(); phone = await mobile.newPage();
    for (const page of [host.page, phone]) page.on('pageerror', error => errors.push(error.message));
    await host.page.exposeFunction('fixtureSignal', (to, data) => host.send({ type: 'signal', to, data }));
    await host.page.goto(broker.url + '/health');
    await host.page.evaluate(async id => {
      const { RoomRTC } = await import('/rtc.js'); window.fixtureErrors = []; window.rtc = new RoomRTC({ selfId: id, signal: (to, data) => fixtureSignal(to, data) });
      rtc.addEventListener('error', event => fixtureErrors.push(event.detail.error?.message));
      rtc.addEventListener('track', event => {
        if (event.detail.kind !== 'screen') return;
        const video = document.createElement('video'); video.id = 'phone-screen'; video.autoplay = true; video.muted = true; video.srcObject = new MediaStream([event.detail.track]); document.body.append(video);
      });
      rtc.addEventListener('track-removed', event => { if (event.detail.kind === 'screen') document.getElementById('phone-screen')?.remove(); });
    }, host.id);
    const invite = `${broker.url}/#key=${broker.roomKey}&fp=${fingerprint(cert.cert)}`;
    phase = 'phone admission'; await phone.goto(invite); await phone.waitForFunction(() => document.getElementById('join-dialog').open);
    await phone.locator('#join-name').fill('Phone owner QA'); await phone.locator('#join-submit').click();
    const pending = await host.take('join-request'); host.send({ type: 'approve', peerId: pending.peerId });
    await host.page.evaluate(peer => rtc.addPeer(peer), { id: pending.peerId, name: 'Phone owner QA' }); host.ready = true; for (const signal of host.signals.splice(0)) host.deliver(signal);
    await phone.waitForFunction(() => !document.getElementById('share-button').disabled);
    assert.equal(await phone.locator('#quality-select option[value="1440"]').isDisabled(), true);
    assert.match(await phone.locator('#quality-select option[value="1080"]').textContent(), /phone maximum/);
    assert.equal(await phone.evaluate(() => qaPhone.started), 0);
    phase = 'native screen contract and RTP'; await phone.locator('#share-button').click();
    await phone.waitForFunction(() => document.getElementById('share-button').getAttribute('aria-label') === 'Stop sharing screen');
    await host.page.waitForFunction(() => { const video = document.getElementById('phone-screen'); return video?.videoWidth > 0 && video.videoHeight > video.videoWidth; }, undefined, { timeout: 20000 });
    await phone.waitForFunction(() => qaPhone.acked.length >= 3);
    assert.deepEqual(await phone.evaluate(() => qaPhone.options), { quality: '720p', microphone: false });
    const decoded = await host.page.evaluate(async peerId => {
      const video = document.getElementById('phone-screen'); const report = await rtc.peers.get(peerId).pc.getStats(); const rows = [];
      report.forEach(row => { if (row.type === 'inbound-rtp' && row.kind === 'video') rows.push({ decoded: row.framesDecoded, received: row.bytesReceived }); });
      return { width: video.videoWidth, height: video.videoHeight, rows };
    }, pending.peerId);
    assert.ok(decoded.rows.some(row => row.decoded > 0 && row.received > 0));
    phase = 'invalid-frame recovery';
    const before = await phone.evaluate(() => qaPhone.acked.length);
    await phone.evaluate(() => qaPhone.frame({ seq: ++qaPhone.sequence, data: 'data:image/jpeg;base64,invalid', width: 720, height: 1280 }));
    await phone.waitForFunction(before => qaPhone.acked.length > before + 1, before);
    phase = 'explicit control consent'; host.send({ type: 'control-request', to: pending.peerId });
    await phone.waitForFunction(() => document.getElementById('control-dialog').open);
    assert.equal(await phone.evaluate(() => qaPhone.grant), null, 'Control request must not grant native input before approval');
    await phone.locator('#allow-control').click(); const granted = await host.take('control-response'); assert.equal(granted.accepted, true);
    await phone.waitForFunction(() => !document.getElementById('control-banner').hidden);
    await host.page.waitForFunction(peerId => rtc.peers.get(peerId)?.channel?.readyState === 'open', pending.peerId);
    await host.page.evaluate(({ peerId, sessionId }) => rtc.sendData(peerId, { type: 'input', sessionId, event: { type: 'down', seq: 1, button: 0, x: .4, y: .3 } }), { peerId: pending.peerId, sessionId: granted.sessionId });
    await phone.waitForFunction(() => qaPhone.inputs.length === 1);
    assert.equal(await phone.evaluate(() => qaPhone.inputs[0].peerId), host.id);
    phase = 'owner revoke'; await phone.locator('#stop-control').click(); await host.take('control-revoke');
    assert.equal(await phone.evaluate(() => qaPhone.grant), null);
    await host.page.evaluate(({ peerId, sessionId }) => rtc.sendData(peerId, { type: 'input', sessionId, event: { type: 'up', seq: 2, button: 0, x: .4, y: .3 } }), { peerId: pending.peerId, sessionId: granted.sessionId });
    await assert.rejects(phone.waitForFunction(() => qaPhone.inputs.length > 1, undefined, { timeout: 350 }), /Timeout/);
    phase = 'projection stop'; await phone.locator('#share-button').click(); await host.page.waitForFunction(() => !document.getElementById('phone-screen'));
    await phone.waitForFunction(() => !qaPhone.timer && !qaPhone.frame);
    phase = 'unsupported WebView recovery'; await phone.evaluate(() => { window.MediaStreamTrackGenerator = undefined; });
    await phone.locator('#share-button').click();
    await phone.waitForFunction(() => document.getElementById('toast-region').textContent.includes('Update Android System WebView'));
    assert.equal(await phone.evaluate(() => qaPhone.started), 1, 'Unsupported frame generation must fail before requesting another native projection');
    result = { passed: true, environment: 'Real HTTPS broker and RTC engine; mobile UI; explicit native Android bridge fixture producing720x1280JPEG frames',
      verified: ['no projection on join', 'phone share button calls native consent contract', 'quality and current microphone flag passed', 'JPEGs become explicit VideoFrames with native acknowledgments while canvas capture and DOM image decoding are disabled',
        'desktop actually decodes portrait RTP video', 'bad JPEG acknowledged and following frames recover', 'phone accepts control only after explicit review', 'approved input bound to remote peer/session', 'owner revocation rejects late input', 'stop releases stream and frame subscription', 'older WebView gets update guidance before native projection starts'],
      limitations: ['Native projection approval, Accessibility and Android background lifecycle are fixtures; a physical phone test is required'], decoded, errors };
    assert.deepEqual(errors, []); assert.deepEqual(await host.page.evaluate(() => fixtureErrors), []);
  } catch (error) { failure = new Error(`${phase}: ${error.stack}`); }
  finally {
    phase = 'fixture shutdown';
    const cleanup = async (label, action) => { try { await action(); } catch (error) { reportError(`${phase}: ${label}: ${error.message}`); } };
    // Stop frame and RTC producers while their pages still exist. Disconnect
    // signaling and drain every already-enqueued delivery before closing pages.
    if (phone && !phone.isClosed()) await cleanup('stop projection producer', () => phone.evaluate(() => { clearInterval(qaPhone.timer); qaPhone.timer = null; qaPhone.frame = null; }));
    if (host?.page && !host.page.isClosed()) await cleanup('stop RTC producer', () => host.page.evaluate(() => window.rtc?.close()));
    if (host) await cleanup('drain fixture signaling', () => host.stop());
    for (const context of contexts) await cleanup('close browser context', () => context.close());
    if (browser) await cleanup('close browser', () => browser.close());
    if (broker) await cleanup('stop broker', () => broker.stop());
  }
  if (failure) throw failure;
  assert.deepEqual(errors, [], 'No active-phase or shutdown fixture failures may be hidden');
  fs.writeFileSync(path.join(output, 'phone-share-browser.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
