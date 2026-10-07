'use strict';

// Browser UI integration with a protocol-fixture host. Chromium fake devices only.
// No camera/microphone hardware, native input, actual Android device, or internet path is exercised.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');
const selfsigned = require('selfsigned');
const { chromium } = require('playwright');
const { createBroker } = require('../src/core/broker.cjs');
const { fingerprint } = require('../src/core/invite.cjs');

const candidates = [process.env.AURALINK_TEST_BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/google-chrome'].filter(Boolean);
const browserPath = candidates.find(file => fs.existsSync(file));
if (!browserPath) throw new Error('Install Edge/Chrome or set AURALINK_TEST_BROWSER. This test does not download a browser.');

function client(broker) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(broker.url.replace(/^http/, 'ws') + '/ws', { rejectUnauthorized: false });
    const peer = { ws, messages: [], waiters: [], signalCount: 0 };
    peer.send = msg => ws.send(JSON.stringify(msg));
    peer.take = type => {
      const index = peer.messages.findIndex(msg => msg.type === type);
      if (index >= 0) return Promise.resolve(peer.messages.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { type, resolve };
        waiter.timer = setTimeout(() => { peer.waiters = peer.waiters.filter(item => item !== waiter); reject(new Error(`Timed out waiting for ${type}`)); }, 8000);
        peer.waiters.push(waiter);
      });
    };
    ws.on('message', raw => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'signal') { peer.signalCount++; return; }
      const index = peer.waiters.findIndex(item => item.type === message.type);
      if (index >= 0) { const [waiter] = peer.waiters.splice(index, 1); clearTimeout(waiter.timer); waiter.resolve(message); }
      else peer.messages.push(message);
    });
    ws.once('open', () => resolve(peer)); ws.on('error', reject);
  });
}

async function joinUI(page, invite, name, host, approve = true) {
  // Exercise a newly opened invitation. A hash-only same-document navigation does
  // not reload modules in browsers, so it is a different interaction from opening it.
  await page.goto('about:blank');
  await page.goto(invite);
  await page.waitForFunction(() => document.getElementById('join-dialog').open);
  assert.equal(await page.locator('#join-invite').inputValue(), invite);
  assert.equal(await page.evaluate(() => location.hash), '', 'Invitation fragment should be cleared from browser history');
  await page.locator('#join-name').fill(name);
  await page.locator('#join-submit').click();
  const request = await host.take('join-request'); assert.equal(request.name, name);
  await page.waitForFunction(() => document.getElementById('connection-pill').textContent.includes('Awaiting host approval'));
  assert.equal(await page.locator('#camera-button').isDisabled(), true);
  assert.equal(await page.locator('#mic-button').isDisabled(), true);
  assert.deepEqual(await page.evaluate(() => window.qaCaptureCalls), [], 'No media capture should be requested before host approval');
  host.send({ type: approve ? 'approve' : 'reject', peerId: request.peerId });
  if (approve) {
    await page.waitForFunction(() => !document.getElementById('camera-button').disabled);
    assert.equal(await page.locator('#camera-button').getAttribute('aria-label'), 'Turn camera on');
    assert.equal(await page.locator('#mic-button').getAttribute('aria-label'), 'Turn microphone on');
    assert.equal(await page.locator('#request-control').isDisabled(), true);
    assert.deepEqual(await page.evaluate(() => window.qaCaptureCalls), [], 'Admission must not automatically capture media');
  } else {
    await page.waitForFunction(() => !document.getElementById('lobby').hidden && document.getElementById('session').hidden);
    await page.waitForFunction(() => document.getElementById('toast-region').textContent.includes('declined'));
  }
  return request.peerId;
}

async function receiverProof(page, peerName) {
  await page.getByRole('button', { name: `View ${peerName}`, exact: true }).click();
  await page.waitForFunction(() => {
    const video = document.getElementById('stage-video');
    return !video.hidden && video.videoWidth > 0 && video.videoHeight > 0 && video.readyState >= 2 && video.currentTime > 0;
  }, undefined, { timeout: 20000 });
  await page.locator('#diagnostics-toggle').click();
  const panel = page.locator('.stats-peer').filter({ has: page.locator('strong').filter({ hasText: peerName }) });
  await page.waitForFunction(name => [...document.querySelectorAll('.stats-peer')].some(panel => {
    const rows = [...panel.querySelectorAll('.stat-row')];
    return panel.querySelector('strong')?.textContent === name && rows.some(row => row.textContent.includes('Received video') && /\d+\s*×\s*\d+/.test(row.textContent));
  }), peerName, { timeout: 20000 });
  const statsText = await panel.innerText();
  assert.match(statsText, /Direct.*udp/s);
  assert.match(statsText, /Received codec\nvideo\//);
  const video = await page.locator('#stage-video').evaluate(video => ({ width: video.videoWidth, height: video.videoHeight,
    currentTime: video.currentTime, presentedFrames: video.getVideoPlaybackQuality?.().totalVideoFrames ?? null }));
  assert.ok(video.width > 0 && video.height > 0 && video.currentTime > 0);
  await page.locator('#diagnostics-close').click();
  return { receiverOf: peerName, video, statistics: statsText };
}

async function main() {
  let broker, browser;
  let phase = 'setup'; let desktopPage; let mobilePage;
  const protocolClients = []; const contexts = []; const errors = [];
  const outputDir = path.resolve(__dirname, '..', 'test-results');
  await fs.promises.mkdir(outputDir, { recursive: true });
  try {
    const pems = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], { keySize: 2048, algorithm: 'sha256' });
    broker = await createBroker({ host: '127.0.0.1', name: 'Browser UI verification',
      tls: { key: pems.private, cert: pems.cert }, assetsDir: path.join(__dirname, '..', 'src', 'renderer') });
    const host = await client(broker); protocolClients.push(host);
    host.send({ type: 'join', name: 'Protocol fixture host', roomKey: broker.roomKey, hostToken: broker.hostToken });
    const hostWelcome = await host.take('welcome');
    assert.equal(hostWelcome.hostId, hostWelcome.selfId);
    const invite = `${broker.url}/#key=${broker.roomKey}&fp=${fingerprint(pems.cert)}`;
    browser = await chromium.launch({ executablePath: browserPath, headless: true,
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
    const desktopContext = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 850 }, permissions: ['camera', 'microphone'] });
    const mobileContext = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, permissions: ['camera', 'microphone'],
      userAgent: 'Mozilla/5.0 (Linux; Android 15; QA viewport) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36' });
    contexts.push(desktopContext, mobileContext);
    for (const context of contexts) await context.addInitScript(() => {
      window.qaCaptureCalls = [];
      for (const method of ['getUserMedia', 'getDisplayMedia']) {
        const original = navigator.mediaDevices?.[method];
        if (!original) continue;
        navigator.mediaDevices[method] = function (...args) {
          window.qaCaptureCalls.push(method); return original.apply(this, args);
        };
      }
    });
    const desktop = await desktopContext.newPage(); const mobile = await mobileContext.newPage();
    desktopPage = desktop; mobilePage = mobile;
    for (const page of [desktop, mobile]) page.on('pageerror', error => errors.push(error.message));
    await mobile.goto(broker.url + '/'); await mobile.locator('#join-button').waitFor();
    await mobile.screenshot({ path: path.join(outputDir, 'mobile-lobby.png'), fullPage: true });
    assert.ok(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Mobile lobby overflows horizontally');
    phase = 'desktop UI admission'; await joinUI(desktop, invite, 'Desktop UI QA', host);
    phase = 'mobile UI admission'; await joinUI(mobile, invite, 'Mobile UI QA', host);
    phase = 'fake camera activation';
    await desktop.locator('#camera-button').click(); await mobile.locator('#camera-button').click();
    await desktop.waitForFunction(() => document.getElementById('camera-button').getAttribute('aria-label') === 'Turn camera off');
    await mobile.waitForFunction(() => document.getElementById('camera-button').getAttribute('aria-label') === 'Turn camera off');
    assert.deepEqual(await desktop.evaluate(() => window.qaCaptureCalls), ['getUserMedia']);
    assert.deepEqual(await mobile.evaluate(() => window.qaCaptureCalls), ['getUserMedia']);
    phase = 'desktop received video'; const desktopReceived = await receiverProof(desktop, 'Mobile UI QA');
    phase = 'mobile received video'; const received = [desktopReceived, await receiverProof(mobile, 'Desktop UI QA')];
    phase = 'fullscreen control';
    await desktop.locator('#fullscreen-button').click();
    await desktop.waitForFunction(() => document.fullscreenElement?.id === 'stage');
    assert.equal(await desktop.locator('#fullscreen-button').getAttribute('aria-label'), 'Exit fullscreen');
    await desktop.locator('#fullscreen-button').click();
    await desktop.waitForFunction(() => !document.fullscreenElement);
    phase = 'media equipment preferences';
    await desktop.locator('[data-view="settings"]').click();
    await desktop.locator('#refresh-devices').click();
    await desktop.waitForFunction(() => document.getElementById('camera-device').options.length > 1 && document.getElementById('microphone-device').options.length > 1);
    const mediaDevice = await desktop.locator('#camera-device').evaluate(select => select.options[1].value);
    await desktop.locator('#camera-device').selectOption(mediaDevice);
    await desktop.locator('#save-settings').click();
    assert.equal(await desktop.evaluate(() => JSON.parse(localStorage.getItem('auralink.preferences')).camera), mediaDevice);
    await desktop.locator('[data-view="rooms"]').click();
    assert.ok(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Mobile room overflows horizontally');
    await mobile.waitForFunction(() => document.getElementById('toast-region').childElementCount === 0, undefined, { timeout: 10000 });
    await mobile.screenshot({ path: path.join(outputDir, 'mobile-room.png'), fullPage: true });

    phase = 'four participant limit'; const fourth = await client(broker); protocolClients.push(fourth);
    fourth.send({ type: 'join', name: 'Fourth protocol fixture', roomKey: broker.roomKey });
    const fourthPending = await fourth.take('pending'); await host.take('join-request');
    host.send({ type: 'approve', peerId: fourthPending.selfId }); await fourth.take('welcome');
    const fifth = await client(broker); protocolClients.push(fifth);
    fifth.send({ type: 'join', name: 'Fifth denied fixture', roomKey: broker.roomKey });
    assert.match((await fifth.take('error')).message, /room is full/);
    host.send({ type: 'kick', peerId: fourthPending.selfId }); await fourth.take('rejected');

    phase = 'mobile rejection'; await mobile.locator('#end-button').click();
    await mobile.waitForFunction(() => document.getElementById('session').hidden);
    await joinUI(mobile, invite, 'Rejected UI QA', host, false);
    assert.deepEqual(errors, []);
    const result = { passed: true,
      environment: 'Windows installed Edge; local HTTPS broker with authenticated WebSocket host fixture; one desktop and one 412x915 mobile viewport; fake browser cameras only',
      limitations: ['Fixture host has no media engine', 'Mobile viewport is not a physical Android test', 'No native input, physical camera/microphone, internet path or guaranteed video resolution tested'],
      verified: ['invitation prefill and fragment clearance', 'host approval gates UI media controls', 'camera and microphone remain off on admission',
        'no capture API requested before approval or automatically on admission; explicit camera click invokes capture',
        'both UI clients decode fake camera frames', 'DOM displays live received resolution and direct UDP route', 'four-person limit and fifth request refusal',
        'received codec displayed from actual stats', 'fullscreen enter/exit', 'fake camera and microphone equipment enumeration and camera preference saved locally',
        'host rejection returns UI to lobby', '412x915 mobile layout has no horizontal overflow', 'no browser JavaScript errors'], received, errors };
    await fs.promises.writeFile(path.join(outputDir, 'ui-browser.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    const diagnostics = [];
    for (const page of [desktopPage, mobilePage].filter(Boolean)) {
      try { diagnostics.push(await page.evaluate(() => ({ status: document.getElementById('connection-pill')?.textContent,
        camera: document.getElementById('camera-button')?.getAttribute('aria-label'),
        microphone: document.getElementById('mic-button')?.getAttribute('aria-label'),
        toast: document.getElementById('toast-region')?.textContent, sessionHidden: document.getElementById('session')?.hidden }))); } catch {}
    }
    throw new Error(`${phase}: ${error.stack}\n${JSON.stringify({ errors, diagnostics })}`);
  } finally {
    for (const context of contexts) await context.close().catch(() => {});
    await browser?.close();
    for (const peer of protocolClients) peer.ws.terminate();
    await broker?.stop();
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
