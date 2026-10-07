'use strict';

// Approved mobile controller UX over a real RTC data channel to a fixture owner.
// The owner provides synthetic screen video and never creates a native input adapter.
// This checks protocol events; it cannot prove native desktop input or physical Android behavior.
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
const executablePath = candidates.find(file => fs.existsSync(file));
if (!executablePath) throw new Error('Install Edge/Chrome or set AURALINK_TEST_BROWSER. No browser is downloaded.');

async function ownerFixture(broker) {
  const ws = new WebSocket(broker.url.replace(/^http/, 'ws') + '/ws', { rejectUnauthorized: false });
  const owner = { ws, page: null, peerReady: false, signals: [], inbox: [], waits: [], trace: [], chain: Promise.resolve() };
  owner.send = packet => { if (packet.data?.description) owner.trace.push({ direction: 'send', description: packet.data.description.type }); ws.send(JSON.stringify(packet)); };
  owner.take = type => {
    const index = owner.inbox.findIndex(packet => packet.type === type);
    if (index >= 0) return Promise.resolve(owner.inbox.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { type, resolve };
      waiter.timer = setTimeout(() => { owner.waits = owner.waits.filter(item => item !== waiter); reject(new Error(`Owner timed out waiting for ${type}.`)); }, 8000);
      owner.waits.push(waiter);
    });
  };
  owner.deliver = packet => {
    owner.chain = owner.chain.then(() => owner.page.evaluate(packet => rtc.receive(packet.from, packet.data), packet));
  };
  ws.on('message', raw => {
    const packet = JSON.parse(raw.toString());
    if (packet.data?.description) owner.trace.push({ direction: 'receive', description: packet.data.description.type });
    if (packet.type === 'error') owner.trace.push({ error: packet.message });
    if (packet.type === 'signal') { if (owner.peerReady) owner.deliver(packet); else owner.signals.push(packet); return; }
    const index = owner.waits.findIndex(waiter => waiter.type === packet.type);
    if (index >= 0) { const [waiter] = owner.waits.splice(index, 1); clearTimeout(waiter.timer); waiter.resolve(packet); }
    else owner.inbox.push(packet);
  });
  ws.on('error', () => {});
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  owner.send({ type: 'join', name: 'Synthetic display owner', roomKey: broker.roomKey, hostToken: broker.hostToken });
  owner.id = (await owner.take('welcome')).selfId;
  return owner;
}

async function eventCount(owner) { return owner.page.evaluate(() => fixtureInputs.length); }
async function assertNoInputs(owner, action, message) {
  const before = await eventCount(owner); await action();
  await assert.rejects(owner.page.waitForFunction(before => fixtureInputs.length > before, before, { timeout: 200 }), /Timeout/);
  assert.equal(await eventCount(owner), before, message);
}
async function waitForInputs(owner, count) {
  await owner.page.waitForFunction(count => fixtureInputs.length >= count, count, { timeout: 5000 });
  return owner.page.evaluate(() => fixtureInputs);
}

async function clickKey(guest, owner, id, code) {
  const before = await eventCount(owner);
  await guest.locator(id).click();
  const inputs = await waitForInputs(owner, before + 2);
  const sent = inputs.slice(before).map(packet => packet.data.event);
  assert.deepEqual(sent.slice(-2).map(event => ({ type: event.type, code: event.code })), [{ type: 'keydown', code }, { type: 'keyup', code }]);
  return { button: id, code };
}

async function main({ negotiationOnly = false } = {}) {
  let broker, browser, owner, guest; let phase = 'setup'; const contexts = []; const errors = [];
  const outputDir = path.resolve(__dirname, '..', 'test-results');
  await fs.promises.mkdir(outputDir, { recursive: true });
  try {
    const pems = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], { keySize: 2048, algorithm: 'sha256' });
    broker = await createBroker({ host: '127.0.0.1', name: 'Mobile control verification', tls: { key: pems.private, cert: pems.cert },
      assetsDir: path.resolve(__dirname, '..', 'src', 'renderer') });
    owner = await ownerFixture(broker);
    browser = await chromium.launch({ executablePath, headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
    const ownerContext = await browser.newContext({ ignoreHTTPSErrors: true });
    const guestContext = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true,
      userAgent: 'Mozilla/5.0 (Linux; Android 15; QA viewport) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36' });
    contexts.push(ownerContext, guestContext);
    await guestContext.addInitScript(() => {
      window.qaSignalTrace = [];
      const NativeWebSocket = window.WebSocket;
      window.WebSocket = class extends NativeWebSocket {
        constructor(...args) {
          super(...args);
          this.addEventListener('message', event => {
            try { const packet = JSON.parse(event.data); if (packet.data?.description) qaSignalTrace.push({ direction: 'receive', description: packet.data.description.type }); if (packet.type === 'error') qaSignalTrace.push({ error: packet.message }); } catch {}
          });
        }
        send(raw) {
          try { const packet = JSON.parse(raw); if (packet.data?.description) qaSignalTrace.push({ direction: 'send', description: packet.data.description.type }); } catch {}
          return super.send(raw);
        }
      };
    });
    owner.page = await ownerContext.newPage(); guest = await guestContext.newPage();
    for (const page of [owner.page, guest]) page.on('pageerror', error => errors.push(error.message));
    await owner.page.exposeFunction('ownerSignal', (to, data) => owner.send({ type: 'signal', to, data }));
    await owner.page.goto(broker.url + '/health');
    await owner.page.evaluate(async id => {
      const { RoomRTC } = await import('/rtc.js');
      window.fixtureInputs = []; window.fixtureErrors = [];
      window.rtc = new RoomRTC({ selfId: id, signal: (to, data) => window.ownerSignal(to, data), iceServers: [] });
      rtc.addEventListener('data', event => fixtureInputs.push(event.detail));
      rtc.addEventListener('error', event => fixtureErrors.push(event.detail.error?.message));
      const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
      const draw = canvas.getContext('2d'); let frame = 0;
      const paint = () => { draw.fillStyle = '#112b41'; draw.fillRect(0, 0, 1280, 720); draw.fillStyle = '#68e6c0';
        draw.font = '40px sans-serif'; draw.fillText('Synthetic remote display — native input disabled', 40, 90);
        draw.fillRect(40 + (frame++ * 4) % 900, 170, 240, 160); };
      paint(); window.fixtureTimer = setInterval(paint, 90);
      const stream = canvas.captureStream(10); await rtc.setTrack('screen', stream.getVideoTracks()[0], stream);
    }, owner.id);
    const invite = `${broker.url}/#key=${broker.roomKey}&fp=${fingerprint(pems.cert)}`;
    phase = 'guest admission'; await guest.goto(invite);
    await guest.waitForFunction(() => document.getElementById('join-dialog').open);
    await guest.locator('#join-name').fill('Mobile controller QA'); await guest.locator('#join-submit').click();
    const admission = await owner.take('join-request'); owner.send({ type: 'approve', peerId: admission.peerId });
    await owner.page.evaluate(peer => rtc.addPeer(peer), { id: admission.peerId, name: admission.name, role: 'guest' });
    owner.peerReady = true; for (const packet of owner.signals.splice(0)) owner.deliver(packet);
    phase = 'remote display decode';
    await guest.waitForFunction(() => {
      const video = document.getElementById('stage-video');
      return !video.hidden && video.videoWidth > 0 && document.getElementById('stage-label-text').textContent.includes('screen');
    }, undefined, { timeout: 20000 });
    await owner.page.waitForFunction(id => rtc.peers.get(id)?.channel?.readyState === 'open', admission.peerId, { timeout: 10000 });
    await owner.page.waitForFunction(id => rtc.peers.get(id)?.pc.signalingState === 'stable', admission.peerId, { timeout: 10000 });
    if (negotiationOnly) {
      const video = await guest.locator('#stage-video').evaluate(video => ({ width: video.videoWidth, height: video.videoHeight, ready: video.readyState }));
      const result = { passed: true, ownerPolite: owner.id.localeCompare(admission.peerId) > 0, video,
        verified: ['owner screen preloaded before guest admission', 'actual decoded synthetic screen', 'RTC data channel open', 'final owner signaling state stable'],
        signalingTrace: owner.trace, errors };
      assert.ok(video.width > 0 && video.height > 0); assert.deepEqual(errors, []);
      return result;
    }
    assert.equal(await guest.locator('#remote-tools').isVisible(), false);
    await assertNoInputs(owner, () => guest.locator('#stage-video').click({ position: { x: 160, y: 150 } }), 'Screen viewing must not emit remote input');

    phase = 'explicit control approval'; await guest.locator('#request-control').click();
    const request = await owner.take('control-request'); assert.equal(request.from, admission.peerId);
    await assertNoInputs(owner, () => guest.locator('#stage-video').click({ position: { x: 180, y: 140 } }), 'An outstanding request must not authorize input');
    const sessionId = 'fixture-owner-control-session-00001';
    owner.send({ type: 'control-response', to: admission.peerId, accepted: true, sessionId, requestId: request.requestId });
    await owner.take('control-granted');
    await guest.waitForFunction(() => !document.getElementById('remote-tools').hidden && document.getElementById('control-banner-text').textContent.includes('You have control'));

    phase = 'mobile software keyboard'; await guest.locator('#remote-keyboard-toggle').click();
    await guest.locator('#remote-text-input').fill('a1');
    const simple = await waitForInputs(owner, 4);
    assert.deepEqual(simple.slice(0, 4).map(packet => ({ type: packet.data.event.type, code: packet.data.event.code })),
      [{ type: 'keydown', code: 'KeyA' }, { type: 'keyup', code: 'KeyA' }, { type: 'keydown', code: 'Digit1' }, { type: 'keyup', code: 'Digit1' }]);
    assert.equal(await guest.locator('#remote-text-input').inputValue(), '');
    await guest.locator('#remote-text-input').fill('A!');
    const shifted = await waitForInputs(owner, 12);
    assert.deepEqual(shifted.slice(4, 12).map(packet => ({ type: packet.data.event.type, code: packet.data.event.code })),
      [{ type: 'keydown', code: 'ShiftLeft' }, { type: 'keydown', code: 'KeyA' }, { type: 'keyup', code: 'KeyA' }, { type: 'keyup', code: 'ShiftLeft' },
        { type: 'keydown', code: 'ShiftLeft' }, { type: 'keydown', code: 'Digit1' }, { type: 'keyup', code: 'Digit1' }, { type: 'keyup', code: 'ShiftLeft' }]);
    phase = 'software keyboard composition';
    await guest.locator('#remote-text-input').dispatchEvent('compositionstart', { data: '' });
    await assertNoInputs(owner, () => guest.locator('#remote-text-input').evaluate(input => {
      input.value = 'b'; input.dispatchEvent(new InputEvent('input', { data: 'b', inputType: 'insertCompositionText', isComposing: true, bubbles: true }));
    }), 'In-progress composition must not send keys');
    const compositionBefore = await eventCount(owner);
    await guest.locator('#remote-text-input').evaluate(input => {
      input.dispatchEvent(new CompositionEvent('compositionend', { data: 'b', bubbles: true }));
      input.value = 'b'; input.dispatchEvent(new InputEvent('input', { data: 'b', inputType: 'insertFromComposition', bubbles: true }));
    });
    const composition = await waitForInputs(owner, compositionBefore + 2);
    assert.deepEqual(composition.slice(compositionBefore).map(packet => ({ type: packet.data.event.type, code: packet.data.event.code })),
      [{ type: 'keydown', code: 'KeyB' }, { type: 'keyup', code: 'KeyB' }]);
    await assertNoInputs(owner, async () => {}, 'Composition final input must not duplicate the commit');
    phase = 'unsupported Unicode and character limit';
    await assertNoInputs(owner, () => guest.locator('#remote-text-input').fill('বাংলা🙂'), 'Unsupported Unicode must not produce key events');
    const limitBefore = await eventCount(owner);
    await guest.locator('#remote-text-input').fill('a'.repeat(40));
    const limited = await waitForInputs(owner, limitBefore + 64);
    assert.equal(limited.length - limitBefore, 64, 'Only32 characters should produce64 paired key events');
    assert.ok(limited.slice(limitBefore).every(packet => packet.data.event.code === 'KeyA'));
    await assertNoInputs(owner, async () => {}, 'Extra characters must not leak after truncation');
    const keys = [];
    for (const [id, code] of [['#remote-enter', 'Enter'], ['#remote-backspace', 'Backspace'], ['#remote-tab', 'Tab'],
      ['#remote-escape', 'Escape'], ['#remote-home', 'Home'],
      ['#remote-arrow-up', 'ArrowUp'], ['#remote-arrow-down', 'ArrowDown'], ['#remote-arrow-left', 'ArrowLeft'], ['#remote-arrow-right', 'ArrowRight']]) {
      keys.push(await clickKey(guest, owner, id, code));
    }

    phase = 'mobile pointer and scrolling';
    let before = await eventCount(owner); await guest.locator('#remote-right-click').click();
    let inputs = await waitForInputs(owner, before + 3);
    assert.deepEqual(inputs.slice(before).map(packet => ({ type: packet.data.event.type, button: packet.data.event.button })),
      [{ type: 'move', button: undefined }, { type: 'down', button: 2 }, { type: 'up', button: 2 }]);
    before = inputs.length; await guest.locator('#remote-scroll-down').click(); inputs = await waitForInputs(owner, before + 2);
    assert.equal(inputs.at(-1).data.event.type, 'wheel'); assert.ok(inputs.at(-1).data.event.deltaY > 0);
    before = inputs.length; await guest.locator('#remote-scroll-up').click(); inputs = await waitForInputs(owner, before + 2);
    assert.equal(inputs.at(-1).data.event.type, 'wheel'); assert.ok(inputs.at(-1).data.event.deltaY < 0);
    for (let index = 0; index < inputs.length; index++) {
      assert.equal(inputs[index].peerId, admission.peerId); assert.equal(inputs[index].data.type, 'input'); assert.equal(inputs[index].data.sessionId, sessionId);
      assert.ok(inputs[index].data.event.seq > (index ? inputs[index - 1].data.event.seq : 0));
    }
    assert.ok(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Control tools must fit mobile viewport');
    await guest.waitForFunction(() => document.getElementById('toast-region').childElementCount === 0, undefined, { timeout: 10000 });
    await guest.screenshot({ path: path.join(outputDir, 'mobile-control.png'), fullPage: true });

    phase = 'owner revocation'; owner.send({ type: 'control-revoke', to: admission.peerId }); await owner.take('control-revoked');
    await guest.waitForFunction(() => document.getElementById('remote-tools').hidden && document.getElementById('control-banner').hidden);
    assert.equal(await guest.locator('#remote-text-input').inputValue(), '');
    await assertNoInputs(owner, async () => {
      await guest.locator('#stage-video').click({ position: { x: 170, y: 150 } });
      await guest.locator('#stage-video').dispatchEvent('keydown', { code: 'KeyB', key: 'b' });
      await guest.locator('#stage-video').dispatchEvent('keyup', { code: 'KeyB', key: 'b' });
      await guest.locator('#remote-text-input').evaluate(input => {
        input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        input.value = 'c'; input.dispatchEvent(new InputEvent('input', { data: 'c', inputType: 'insertCompositionText', isComposing: true, bubbles: true }));
        input.dispatchEvent(new CompositionEvent('compositionend', { data: 'c', bubbles: true }));
        input.value = 'c'; input.dispatchEvent(new InputEvent('input', { data: 'c', inputType: 'insertFromComposition', bubbles: true }));
      });
    }, 'Input must stop after owner revocation');
    assert.deepEqual(errors, []); assert.deepEqual(await owner.page.evaluate(() => fixtureErrors), []);
    const result = { passed: true, environment: 'Installed Edge; localhost HTTPS broker; actual WebRTC screen/data; mobile412x915 renderer with synthetic owner fixture',
      limitations: ['Owner is a protocol fixture and performs no native input', 'No native approval dialog bypass or app bridge injection', 'No physical Android keyboard/device, desktop input, internet path or high-resolution guarantee tested'],
      verified: ['viewing and pending requests emit no input', 'owner control-response authorizes software keyboard', 'ASCII a1 mapped into safe paired keys', 'uppercase and punctuation use paired Shift without latching',
        'IME in-progress composition emits nothing and final commit sends exactly once', 'unsupported Unicode emits no key events', '40-character insertion is limited to32 paired characters',
        'Enter/Backspace/Tab/arrows paired events', 'right click and both scroll directions', 'RTC sender identity/session binding and increasing input sequences',
        'mobile toolbar fits viewport', 'owner revoke hides tools and prevents further pointer/keys/late IME input', 'no JavaScript or RTC errors'],
      ownerPolite: owner.id.localeCompare(admission.peerId) > 0,
      receivedInputEvents: inputs.length, keys, errors };
    await fs.promises.writeFile(path.join(outputDir, 'mobile-control.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    const diagnostics = guest && !guest.isClosed() ? await guest.evaluate(() => ({ status: document.getElementById('connection-pill')?.textContent,
      toast: document.getElementById('toast-region')?.textContent, label: document.getElementById('stage-label-text')?.textContent,
      video: { width: document.getElementById('stage-video')?.videoWidth, height: document.getElementById('stage-video')?.videoHeight,
        ready: document.getElementById('stage-video')?.readyState, paused: document.getElementById('stage-video')?.paused },
      tools: document.getElementById('remote-tools')?.hidden, banner: document.getElementById('control-banner-text')?.textContent })).catch(() => null) : null;
    if (diagnostics) diagnostics.signals = await guest.evaluate(() => qaSignalTrace);
    const fixture = owner?.page && !owner.page.isClosed() ? await owner.page.evaluate(async () => ({ rtcErrors: fixtureErrors,
      stats: await rtc.stats(), peers: [...rtc.peers].map(([id, entry]) => ({ id, polite: entry.polite, makingOffer: entry.makingOffer, settingAnswer: entry.settingAnswer,
        state: entry.pc.connectionState, signal: entry.pc.signalingState, channel: entry.channel?.readyState,
        transceivers: entry.pc.getTransceivers().map(transceiver => ({ mid: transceiver.mid, direction: transceiver.direction, current: transceiver.currentDirection,
          senderKind: transceiver.sender.track?.kind, senderState: transceiver.sender.track?.readyState })) })) })).catch(() => null) : null;
    throw new Error(`${phase}: ${error.stack}\n${JSON.stringify({ errors, diagnostics, fixture, ownerTrace: owner?.trace })}`);
  } finally {
    if (owner?.page && !owner.page.isClosed()) await owner.page.evaluate(() => { if (window.fixtureTimer) clearInterval(fixtureTimer); window.rtc?.close(); }).catch(() => {});
    for (const context of contexts) await context.close().catch(() => {});
    await browser?.close(); owner?.ws.terminate(); await broker?.stop();
  }
}

async function negotiationRoles() {
  const runs = []; const roles = new Set();
  // Fail immediately on any failed run. Random server-issued identities determine
  // roles; bounded repetitions establish both without accepting intermittent failures.
  for (let attempt = 1; attempt <= 8 && roles.size < 2; attempt++) {
    const result = await main({ negotiationOnly: true });
    runs.push({ attempt, ...result }); roles.add(result.ownerPolite);
    console.log(`Preloaded screen attempt ${attempt}: owner ${result.ownerPolite ? 'polite' : 'impolite'}, decoded ${result.video.width}x${result.video.height}, stable signaling.`);
  }
  assert.equal(roles.size, 2, 'Both owner negotiation roles must be covered within8 attempts');
  const result = { passed: true, environment: 'Local HTTPS broker with real server-issued peer IDs, actual RTC owner fixture and mobile UI synthetic display',
    limitations: ['No native input, physical devices or internet paths', 'Resolution is measured, not guaranteed'], runs };
  await fs.promises.writeFile(path.resolve(__dirname, '..', 'test-results', 'rtc-preloaded-roles.json'), JSON.stringify(result, null, 2));
  console.log('Both polite and impolite preloaded-owner negotiation paths passed with no failed attempts.');
}

(process.argv.includes('--negotiation-roles') ? negotiationRoles() : main()).catch(error => { console.error(error.message); process.exitCode = 1; });
