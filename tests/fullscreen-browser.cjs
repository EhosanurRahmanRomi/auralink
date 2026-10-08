'use strict';

// Real rendered room, decoded remote synthetic video and approved RTC input.
// --electron uses the production main/preload and its native fullscreen IPC.
// No local screen/microphone capture or remote OS input is performed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const selfsigned = require('selfsigned');
const WebSocket = require('ws');
const { chromium, _electron } = require('playwright');
const { createBroker } = require('../src/core/broker.cjs');
const { fingerprint } = require('../src/core/invite.cjs');
const root = path.resolve(__dirname, '..'), output = path.join(root, 'test-results');
const electronMode = process.argv.includes('--electron');
const executablePath = [process.env.AURALINK_TEST_BROWSER, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/chromium', '/usr/bin/google-chrome'].filter(Boolean).find(file => fs.existsSync(file));
if (!executablePath) throw new Error('Install Edge/Chrome or set AURALINK_TEST_BROWSER. No browser is downloaded.');

async function fixture(broker, context) {
  const page = await context.newPage();
  const ws = new WebSocket(broker.url.replace(/^http/, 'ws') + '/ws', { rejectUnauthorized: false });
  const owner = { ws, page, ready: false, signals: [], inbox: [], waiters: [], chain: Promise.resolve(), observedTypes: [] };
  owner.send = packet => ws.send(JSON.stringify(packet));
  owner.take = type => {
    const index = owner.inbox.findIndex(packet => packet.type === type);
    if (index >= 0) return Promise.resolve(owner.inbox.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { type, resolve }; waiter.timer = setTimeout(() => {
        owner.waiters = owner.waiters.filter(item => item !== waiter); reject(new Error(`No ${type} from the fixture.`));
      }, 10000); owner.waiters.push(waiter);
    });
  };
  owner.deliver = packet => { owner.chain = owner.chain.then(() => owner.page.evaluate(packet => rtc.receive(packet.from, packet.data), packet)); };
  ws.on('message', raw => {
    const packet = JSON.parse(raw.toString());
    if (packet.type !== 'signal') owner.observedTypes.push(packet.type);
    if (packet.type === 'signal') { if (owner.ready) owner.deliver(packet); else owner.signals.push(packet); return; }
    const index = owner.waiters.findIndex(waiter => waiter.type === packet.type);
    if (index >= 0) { const [waiter] = owner.waiters.splice(index, 1); clearTimeout(waiter.timer); waiter.resolve(packet); }
    else owner.inbox.push(packet);
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  owner.send({ type: 'join', name: 'Synthetic remote display', roomKey: broker.roomKey, hostToken: broker.hostToken });
  owner.id = (await owner.take('welcome')).selfId;
  await owner.page.exposeFunction('fixtureSignal', (to, data) => owner.send({ type: 'signal', to, data }));
  await owner.page.goto(broker.url + '/health');
  await owner.page.evaluate(async id => {
    const { RoomRTC } = await import('/rtc.js'); window.fixtureInputs = []; window.fixtureErrors = [];
    window.rtc = new RoomRTC({ selfId: id, signal: (to, data) => fixtureSignal(to, data), iceServers: [] });
    rtc.addEventListener('data', event => fixtureInputs.push(event.detail));
    rtc.addEventListener('error', event => fixtureErrors.push(event.detail.error?.message));
    const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
    const draw = canvas.getContext('2d'); let frame = 0;
    const paint = () => { draw.fillStyle = '#30174b'; draw.fillRect(0, 0, 1280, 720);
      draw.fillStyle = '#62e8f6'; draw.fillRect(80 + frame++ * 6 % 1000, 140, 150, 100);
      draw.font = '36px sans-serif'; draw.fillStyle = '#ffffff'; draw.fillText('Remote synthetic display — no OS input', 40, 80); };
    paint(); window.fixtureTimer = setInterval(paint, 80);
    const stream = canvas.captureStream(12); await rtc.setTrack('screen', stream.getVideoTracks()[0], stream);
  }, owner.id);
  return owner;
}

async function inputs(owner) { return owner.page.evaluate(() => fixtureInputs); }
async function noInputs(owner, action) {
  const before = (await inputs(owner)).length; await action();
  await assert.rejects(owner.page.waitForFunction(count => fixtureInputs.length > count, before, { timeout: 250 }), /Timeout/);
  assert.equal((await inputs(owner)).length, before, 'Viewing/exit/revoked actions must not grant or emit input');
}
async function waitInputs(owner, count) {
  await owner.page.waitForFunction(count => fixtureInputs.length >= count, count, { timeout: 5000 }); return inputs(owner);
}
async function presentationBounds(page) {
  return page.evaluate(() => {
    const bounds = element => { const { left, top, right, bottom, width, height } = element.getBoundingClientRect(); return { left, top, right, bottom, width, height }; };
    return { viewport: { width: innerWidth, height: innerHeight }, stage: bounds(document.getElementById('stage')),
      video: bounds(document.getElementById('stage-video')), toolbar: bounds(document.getElementById('presentation-toolbar')),
      buttons: ['presentation-fullscreen-exit', 'presentation-control-button', 'presentation-mic-button', 'presentation-share-button', 'presentation-leave-button'].map(id => {
        const element = document.getElementById(id), rect = bounds(element); return { id, ...rect,
          reachable: element.contains(document.elementFromPoint((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2)) };
      }), active: document.body.classList.contains('presentation-mode'), mode: document.getElementById('stage').dataset.presentation,
      decoded: { width: document.getElementById('stage-video').videoWidth, height: document.getElementById('stage-video').videoHeight }, captureCalls: qaCaptureCalls.slice() };
  });
}
function checkBounds(proof) {
  assert.equal(proof.active, true); assert.ok(proof.stage.left <= 1 && proof.stage.top <= 1);
  assert.ok(proof.stage.right >= proof.viewport.width - 1 && proof.stage.bottom >= proof.viewport.height - 1, 'Stage must fill the current viewport');
  assert.ok(proof.video.height > 80 && proof.video.width > 200, 'A useful live screen remains above the controls');
  assert.ok(proof.video.bottom <= proof.toolbar.top + 1, 'Video must not be hidden behind the presentation controls');
  for (const button of proof.buttons) { assert.ok(button.reachable, `${button.id} must remain reachable`); assert.ok(button.left >= 0 && button.right <= proof.viewport.width + 1); }
  assert.deepEqual(proof.decoded, { width: 1280, height: 720 }); assert.deepEqual(proof.captureCalls, []);
}

async function run(browser, mode) {
  let broker, owner, app, guest, ownerContext, guestContext, profile; let phase = 'setup'; const errors = [];
  const proof = { mode, passed: false, localSensorsCaptured: false, osInputInjected: false };
  try {
    console.log(`Fullscreen ${mode}: setup`);
    const pems = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], { keySize: 2048, algorithm: 'sha256' });
    broker = await createBroker({ host: '127.0.0.1', name: 'Fullscreen verification', tls: { key: pems.private, cert: pems.cert }, assetsDir: path.join(root, 'src', 'renderer') });
    ownerContext = await browser.newContext({ ignoreHTTPSErrors: true }); owner = await fixture(broker, ownerContext);
    console.log(`Fullscreen ${mode}: fixture ready`);
    const invite = `${broker.url}/#key=${broker.roomKey}&fp=${fingerprint(pems.cert)}`;
    if (mode === 'electron') {
      profile = fs.mkdtempSync(path.join(output, 'fullscreen-electron-profile-'));
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
      app = await _electron.launch({ args: [root, '--smoke-test', `--user-data-dir=${profile}`, '--autoplay-policy=no-user-gesture-required', '--mute-audio'], env, timeout: 60000 });
      guest = await app.firstWindow(); await guest.locator('#host-button').waitFor();
      await app.evaluate(({ powerSaveBlocker }) => {
        global.qaSessionPowerIds = [];
        const start = powerSaveBlocker.start.bind(powerSaveBlocker);
        powerSaveBlocker.start = type => { const id = start(type); qaSessionPowerIds.push({ id, type }); return id; };
      });
      await app.evaluate(({ BrowserWindow }) => {
        global.qaFullscreenEvents = []; const win = BrowserWindow.getAllWindows()[0];
        win.on('enter-full-screen', () => qaFullscreenEvents.push(true)); win.on('leave-full-screen', () => qaFullscreenEvents.push(false));
      });
      await guest.locator('#join-button').click(); await guest.locator('#join-invite').fill(invite);
    } else {
      const mobile = mode === 'mobile-unavailable';
      guestContext = await browser.newContext({ ignoreHTTPSErrors: true, viewport: mobile ? { width: 412, height: 915 } : { width: 1280, height: 850 },
        ...(mobile ? { isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 16; QA viewport) AppleWebKit/537.36 Chrome/145.0.0.0 Mobile Safari/537.36' } : {}) });
      await guestContext.addInitScript(mode => {
        if (mode === 'denied') HTMLElement.prototype.requestFullscreen = () => Promise.reject(new DOMException('Fixture policy denies fullscreen', 'NotAllowedError'));
        if (mode === 'mobile-unavailable') HTMLElement.prototype.requestFullscreen = undefined;
      }, mode);
      guest = await guestContext.newPage(); await guest.goto(invite); await guest.waitForFunction(() => document.getElementById('join-dialog').open);
    }
    guest.on('pageerror', error => errors.push(error.message));
    let navigations = 0; guest.on('framenavigated', frame => { if (frame === guest.mainFrame()) navigations++; });
    await guest.evaluate(() => {
      window.qaCaptureCalls = [];
      window.qaViewRTCs = []; const RTC = RTCPeerConnection;
      window.RTCPeerConnection = new Proxy(RTC, { construct(target, args) { const connection = Reflect.construct(target, args); qaViewRTCs.push(connection); return connection; } });
      for (const method of ['getUserMedia', 'getDisplayMedia']) navigator.mediaDevices[method] = async () => { qaCaptureCalls.push(method); throw new Error('Local capture is forbidden in the remote viewing fixture'); };
    });
    phase = 'admission'; console.log(`Fullscreen ${mode}: ${phase}`); await guest.locator('#join-name').fill('Fullscreen viewer'); await guest.locator('#join-submit').click();
    const request = await owner.take('join-request'); owner.send({ type: 'approve', peerId: request.peerId });
    await owner.page.evaluate(peer => rtc.addPeer(peer), { id: request.peerId, name: request.name, role: 'guest' });
    owner.ready = true; for (const packet of owner.signals.splice(0)) owner.deliver(packet);
    await guest.waitForFunction(() => document.getElementById('stage-video').videoWidth === 1280 && document.getElementById('stage-video').currentTime > 0, undefined, { timeout: 20000 });
    await owner.page.waitForFunction(id => rtc.peers.get(id)?.channel?.readyState === 'open', request.peerId);
    if (mode === 'electron') {
      phase = 'rapid native fullscreen toggles'; console.log(`Fullscreen ${mode}: ${phase}`);
      await guest.evaluate(() => {
        window.qaRapidTrack = document.getElementById('stage-video').srcObject.getVideoTracks()[0];
        const button = document.getElementById('fullscreen-button');
        for (let i = 0; i < 3; i++) { button.click(); button.click(); }
      });
      // macOS native animation can finish after both UI clicks. Observe its
      // final real window state after the transition, rather than only CSS.
      await new Promise(resolve => setTimeout(resolve, 4000)); await assertEventually(app, false);
      const retained = await guest.evaluate(() => ({ presentation: document.body.classList.contains('presentation-mode'),
        sameTrack: qaRapidTrack === document.getElementById('stage-video').srcObject.getVideoTracks()[0], roomConnected: !document.getElementById('share-button').disabled }));
      assert.equal(retained.presentation, false); assert.equal(retained.sameTrack, true); assert.equal(retained.roomConnected, true); assert.equal(navigations, 0);
      proof.rapidToggles = { cycles: 3, nativeFullscreenAfterSettling: false, navigationCount: navigations, ...retained,
        actualWindowTransitions: await app.evaluate(() => qaFullscreenEvents.slice()) };
    }

    phase = 'presentation entry'; console.log(`Fullscreen ${mode}: ${phase}`); await guest.locator('#fullscreen-button').click();
    await guest.waitForFunction(() => document.body.classList.contains('presentation-mode') && !document.getElementById('presentation-toolbar').hidden);
    if (mode === 'browser') await guest.waitForFunction(() => document.fullscreenElement?.id === 'stage');
    if (mode === 'electron') { await assertEventually(app, true); assert.equal(await guest.evaluate(() => document.fullscreenElement), null, 'Native app mode does not depend on browser fullscreen'); }
    proof.initialLayout = await presentationBounds(guest); checkBounds(proof.initialLayout);
    assert.equal(await guest.locator('#stage #toast-region').count(), 1, 'Fullscreen must retain visible consent and media notices in its top layer');
    if (mode === 'denied' || mode === 'mobile-unavailable') assert.equal(proof.initialLayout.mode, 'expanded');
    if (mode === 'mobile-unavailable') {
      proof.resizedLayouts = [];
      for (const viewport of [{ width: 360, height: 640 }, { width: 915, height: 412 }, { width: 412, height: 915 }]) {
        await guest.setViewportSize(viewport); const bounds = await presentationBounds(guest); checkBounds(bounds); proof.resizedLayouts.push(bounds);
      }
    }
    await noInputs(owner, () => guest.locator('#stage-video').click());
    assert.equal(await guest.locator('#presentation-control-button').getAttribute('aria-label'), 'Request control');

    phase = 'explicit control approval in fullscreen'; console.log(`Fullscreen ${mode}: ${phase}`); await guest.locator('#presentation-control-button').click();
    const control = await owner.take('control-request'); const sessionId = 'fixture-fullscreen-control-session-001';
    await noInputs(owner, () => guest.locator('#stage-video').click());
    owner.send({ type: 'control-response', to: request.peerId, accepted: true, sessionId, requestId: control.requestId }); await owner.take('control-granted');
    await guest.waitForFunction(() => document.getElementById('presentation-control-button').getAttribute('aria-label') === 'Release control');
    proof.approvedLayout = await presentationBounds(guest); checkBounds(proof.approvedLayout);
    assert.equal(await guest.locator('#stage #remote-tools').count(), 1, 'Approved keyboard tools must remain reachable inside the stage');
    assert.equal(await guest.locator('#remote-tools').isVisible(), false, 'Control tools start collapsed to preserve the full screen image');
    await guest.locator('#presentation-tools-toggle').click(); await guest.locator('#remote-tools').waitFor({ state: 'visible' });
    let keyBefore = (await inputs(owner)).length; await guest.locator('#remote-enter').click();
    const keyEvents = await waitInputs(owner, keyBefore + 2);
    assert.deepEqual(keyEvents.slice(keyBefore).map(packet => ({ type: packet.data.event.type, code: packet.data.event.code })), [{ type: 'keydown', code: 'Enter' }, { type: 'keyup', code: 'Enter' }]);
    await guest.locator('#presentation-tools-toggle').click(); assert.equal(await guest.locator('#remote-tools').isVisible(), false);

    phase = 'fullscreen pointer mapping'; console.log(`Fullscreen ${mode}: ${phase}`); let before = (await inputs(owner)).length;
    await guest.locator('#stage-video').click();
    await owner.page.waitForFunction(before => fixtureInputs.slice(before).some(packet => packet.data.event.type === 'up'), before);
    let events = await inputs(owner);
    const down = events.slice(before).map(packet => packet.data.event).find(event => event.type === 'down');
    assert.ok(Math.abs(down.x - .5) < .015 && Math.abs(down.y - .5) < .015, 'The centre of the contained remote image maps to the remote centre');
    const blackBar = await guest.locator('#stage-video').evaluate(video => {
      const rect = video.getBoundingClientRect(), scale = Math.min(rect.width / video.videoWidth, rect.height / video.videoHeight);
      const width = video.videoWidth * scale, height = video.videoHeight * scale;
      return rect.height - height > 20 ? { x: rect.width / 2, y: 4 } : rect.width - width > 20 ? { x: 4, y: rect.height / 2 } : null;
    });
    if (blackBar) await noInputs(owner, () => guest.locator('#stage-video').click({ position: blackBar }));
    proof.pointerCentre = { x: down.x, y: down.y }; proof.letterboxIgnored = Boolean(blackBar);

    phase = 'Escape releases held input and exits'; console.log(`Fullscreen ${mode}: ${phase}`); await guest.locator('#stage-video').focus(); before = (await inputs(owner)).length;
    await guest.keyboard.down('Shift'); await waitInputs(owner, before + 1); await guest.keyboard.press('Escape');
    await guest.waitForFunction(() => !document.body.classList.contains('presentation-mode'));
    events = await waitInputs(owner, before + 2); const releases = events.slice(before).map(packet => packet.data.event);
    assert.deepEqual(releases.map(event => ({ type: event.type, code: event.code })), [{ type: 'keydown', code: 'ShiftLeft' }, { type: 'keyup', code: 'ShiftLeft' }]);
    await guest.keyboard.up('Shift');
    if (mode === 'electron') await assertEventually(app, false);
    assert.equal(await guest.locator('#session > #remote-tools').count(), 1);
    assert.equal(await guest.locator('body > #toast-region').count(), 1);
    assert.equal(await guest.locator('#request-control').getAttribute('class').then(value => value.includes('enabled')), true, 'Fullscreen exit releases focus but does not invent or discard owner consent');
    const time = await guest.locator('#stage-video').evaluate(video => video.currentTime);
    await guest.waitForFunction(time => document.getElementById('stage-video').currentTime > time, time);
    if (mode === 'electron') {
      phase = 'minimize without room refresh'; console.log(`Fullscreen ${mode}: ${phase}`);
      const initial = await guest.evaluate(async () => {
        const video = document.getElementById('stage-video'); window.qaRetainedVideoTrack = video.srcObject.getVideoTracks()[0];
        window.qaRetainedRoomMarker = crypto.randomUUID();
        const rows = (await Promise.all(qaViewRTCs.map(connection => connection.getStats()))).flatMap(report => [...report.values()]).filter(row => row.type === 'inbound-rtp' && row.kind === 'video');
        return { marker: qaRetainedRoomMarker, time: video.currentTime, decoded: rows.reduce((sum, row) => sum + (row.framesDecoded || 0), 0), packets: rows.reduce((sum, row) => sum + (row.packetsReceived || 0), 0) };
      });
      const native = await app.evaluate(({ BrowserWindow, powerSaveBlocker }) => {
        const win = BrowserWindow.getAllWindows()[0];
        return { backgroundThrottling: win.webContents.getBackgroundThrottling(),
          blockers: qaSessionPowerIds.map(entry => ({ type: entry.type, started: powerSaveBlocker.isStarted(entry.id) })) };
      });
      assert.equal(native.backgroundThrottling, false); assert.ok(native.blockers.some(entry => entry.type === 'prevent-app-suspension' && entry.started));
      await app.evaluate(({ BrowserWindow }) => new Promise((resolve, reject) => {
        const win = BrowserWindow.getAllWindows()[0], timer = setTimeout(() => { win.removeListener('minimize', finish); reject(new Error('Window did not minimize')); }, 5000);
        function finish() { clearTimeout(timer); resolve(); }
        win.once('minimize', finish); win.minimize(); if (win.isMinimized()) { win.removeListener('minimize', finish); finish(); }
      }));
      assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized()), true);
      await new Promise(resolve => setTimeout(resolve, 3000));
      const background = await guest.evaluate(async () => {
        const video = document.getElementById('stage-video');
        const rows = (await Promise.all(qaViewRTCs.map(connection => connection.getStats()))).flatMap(report => [...report.values()]).filter(row => row.type === 'inbound-rtp' && row.kind === 'video');
        return { marker: qaRetainedRoomMarker, sameTrack: qaRetainedVideoTrack === video.srcObject.getVideoTracks()[0], time: video.currentTime,
          decoded: rows.reduce((sum, row) => sum + (row.framesDecoded || 0), 0), packets: rows.reduce((sum, row) => sum + (row.packetsReceived || 0), 0) };
      });
      await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.restore(); win.show(); win.focus(); });
      await guest.waitForFunction(() => !document.hidden);
      assert.equal(background.marker, initial.marker); assert.equal(background.sameTrack, true); assert.equal(navigations, 0);
      assert.ok(background.packets > initial.packets && background.decoded > initial.decoded, 'The actual remote stream must keep arriving and decoding while the window is minimized');
      proof.backgroundRecovery = { minimizedSeconds: 3, navigationCount: navigations, sameVideoTrack: background.sameTrack,
        decodedFramesWhileMinimized: background.decoded - initial.decoded, packetsWhileMinimized: background.packets - initial.packets, native };
    }

    phase = 'fullscreen owner revoke'; console.log(`Fullscreen ${mode}: ${phase}`); await guest.locator('#fullscreen-button').click();
    await guest.waitForFunction(() => document.body.classList.contains('presentation-mode'));
    owner.send({ type: 'control-revoke', to: request.peerId }); await owner.take('control-revoked');
    await guest.waitForFunction(() => document.getElementById('remote-tools').hidden && document.getElementById('presentation-control-button').getAttribute('aria-label') === 'Request control');
    await noInputs(owner, async () => { await guest.locator('#stage-video').click(); await guest.locator('#stage-video').dispatchEvent('keydown', { code: 'KeyA', key: 'a' }); });
    await guest.locator('#presentation-fullscreen-exit').click(); await guest.waitForFunction(() => !document.body.classList.contains('presentation-mode'));
    if (mode === 'electron') await assertEventually(app, false);

    phase = 'leave from fullscreen'; console.log(`Fullscreen ${mode}: ${phase}`); await guest.locator('#fullscreen-button').click(); await guest.locator('#presentation-leave-button').click();
    await guest.waitForFunction(() => document.getElementById('session').hidden && !document.body.classList.contains('presentation-mode'));
    if (mode === 'electron') await assertEventually(app, false);
    assert.deepEqual(await guest.evaluate(() => qaCaptureCalls), []); assert.deepEqual(errors, []); assert.deepEqual(await owner.page.evaluate(() => fixtureErrors), []);
    if (mode === 'electron') assert.ok(await app.evaluate(({ powerSaveBlocker }) => qaSessionPowerIds.length > 0 && qaSessionPowerIds.every(entry => !powerSaveBlocker.isStarted(entry.id))), 'Leaving the room must release every observed production power blocker');
    proof.passed = true; proof.verified = ['decoded remote display retained in fullscreen', 'viewport filled with reachable exit and consent controls',
      'viewing and pending request emit no input', 'owner approval works inside fullscreen', 'contained image centre maps to remote centre',
      'Escape releases held modifiers without sending Escape remotely', 'video continues after fullscreen exit', 'owner revoke disables input immediately',
      'visible exit and leave actions restore the normal room', 'no local screen or microphone capture'];
    if (mode === 'electron') proof.verified.push('production native main/preload fullscreen entry and exit', 'native minimized window retains room and video track while actual remote packets and frames advance', 'admitted room owns prevent-app-suspension and leave releases it');
    return proof;
  } catch (error) {
    const diagnosis = { phase, pageErrorTypes: errors.map(message => String(message).replace(/(?:https?:|auralink:|glance-port:)\/\/\S+/g, '[private invitation removed]').slice(0, 160)) };
    if (guest && !guest.isClosed()) diagnosis.renderer = await guest.evaluate(() => ({
      presentation: document.body.classList.contains('presentation-mode'), presentationMode: document.getElementById('stage').dataset.presentation,
      domFullscreen: document.fullscreenElement?.id || null, visible: !document.hidden, sessionHidden: document.getElementById('session').hidden,
      requestDisabled: document.getElementById('request-control').disabled, requestLabel: document.getElementById('request-control').querySelector('small').textContent,
      presentationControlLabel: document.getElementById('presentation-control-button').getAttribute('aria-label'),
      toolsHidden: document.getElementById('remote-tools').hidden, toolToggleExpanded: document.getElementById('presentation-tools-toggle').getAttribute('aria-expanded'),
      controlBannerHidden: document.getElementById('control-banner').hidden,
      video: { hidden: document.getElementById('stage-video').hidden, width: document.getElementById('stage-video').videoWidth, height: document.getElementById('stage-video').videoHeight, time: document.getElementById('stage-video').currentTime },
      rtc: qaViewRTCs.map(connection => ({ connection: connection.connectionState, ice: connection.iceConnectionState, signaling: connection.signalingState })),
      captureCalls: qaCaptureCalls.slice(), noticeCount: document.getElementById('toast-region').childElementCount,
    })).catch(() => null);
    if (owner?.page && !owner.page.isClosed()) diagnosis.owner = { observedTypes: owner.observedTypes.slice(-20),
      rtc: await owner.page.evaluate(() => ({ inputs: fixtureInputs.length, errors: fixtureErrors.map(value => typeof value),
        peers: [...rtc.peers.values()].map(entry => ({ connection: entry.pc.connectionState, channel: entry.channel?.readyState })) })).catch(() => null) };
    if (app) diagnosis.native = await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; return { fullscreen: win?.isFullScreen(), minimized: win?.isMinimized(), transitions: qaFullscreenEvents.slice() }; }).catch(() => null);
    const failure = new Error(`${mode}: ${phase}: ${error.message}`); failure.diagnosis = diagnosis; throw failure;
  }
  finally {
    if (owner?.page && !owner.page.isClosed()) await owner.page.evaluate(() => { clearInterval(fixtureTimer); rtc.close(); }).catch(() => {});
    owner?.ws.terminate(); await app?.close().catch(() => {}); await guestContext?.close(); await ownerContext?.close(); await broker?.stop();
    if (profile) { const resolved = fs.realpathSync(profile); if (resolved.startsWith(fs.realpathSync(output) + path.sep) && path.basename(resolved).startsWith('fullscreen-electron-profile-')) fs.rmSync(resolved, { recursive: true, force: true }); }
  }
}
async function assertEventually(app, fullscreen) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen()) === fullscreen) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(`Production window fullscreen must become ${fullscreen}`);
}
async function main() {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
  const proof = { passed: false, platform: process.platform, boundary: 'Actual rendered receiver, localhost TLS broker and decoded synthetic remote RTC display. No local sensor capture, physical devices, OS input or internet path.', scenarios: [] };
  try {
    for (const mode of electronMode ? ['electron'] : ['browser', 'denied', 'mobile-unavailable']) proof.scenarios.push(await run(browser, mode));
    proof.passed = true;
  } catch (error) { proof.error = String(error.message).replace(/(?:https?:|auralink:|glance-port:)\/\/\S+/g, '[private invitation removed]'); if (error.diagnosis) proof.diagnosis = error.diagnosis; process.exitCode = 1; }
  finally {
    await browser.close(); fs.writeFileSync(path.join(output, `fullscreen-${electronMode ? 'electron' : 'browser'}.json`), JSON.stringify(proof, null, 2));
    console.log(JSON.stringify({ passed: proof.passed, platform: proof.platform, scenarios: proof.scenarios.map(({ mode, passed, pointerCentre, backgroundRecovery }) => ({ mode, passed, pointerCentre, backgroundRecovery })), ...(proof.error ? { error: proof.error } : {}) }, null, 2));
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
