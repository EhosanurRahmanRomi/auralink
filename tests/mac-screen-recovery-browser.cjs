'use strict';

// Actual production browser renderer and local HTTPS room with a simulated Mac
// bridge/TCC decision. The selected screen is a generated canvas MediaStream.
// No native Mac capture, real permissions, microphone, system audio, or input.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const WebSocket = require('ws');
const selfsigned = require('selfsigned');
const { chromium } = require('playwright');
const { createBroker } = require('../src/core/broker.cjs');
const { fingerprint } = require('../src/core/invite.cjs');
const output = path.resolve(__dirname, '../test-results');
const browserPath = [process.env.GLANCE_PORT_TEST_BROWSER, process.env.AURALINK_TEST_BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/google-chrome']
  .filter(Boolean).find(file => fs.existsSync(file));
if (!browserPath) throw new Error('Install Edge/Chrome or set GLANCE_PORT_TEST_BROWSER.');
const failure = { ok: false, code: 'permission', status: 'denied', reason: 'Allow Glance-Port in System Settings → Privacy & Security → Screen & System Audio Recording, then restart Glance-Port.' };
const available = { ok: true, status: 'granted', fallback: false,
  sources: [{ id: 'screen:qa', name: 'Generated QA display (not Mac hardware)', displayId: '1', canControl: true }] };
const json = value => JSON.parse(JSON.stringify(value));

async function ownerFixture(broker) {
  const socket = new WebSocket(broker.url.replace(/^http/, 'ws') + '/ws', { rejectUnauthorized: false });
  const owner = { socket, pending: [], waits: [], signals: 0 };
  owner.take = type => {
    const index = owner.pending.findIndex(value => value.type === type);
    if (index >= 0) return Promise.resolve(owner.pending.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { type, resolve, reject }; waiter.timer = setTimeout(() => reject(new Error(`No protocol ${type}`)), 8000); owner.waits.push(waiter);
    });
  };
  socket.on('message', data => {
    const value = JSON.parse(data.toString());
    if (value.type === 'signal') { owner.signals++; return; }
    const index = owner.waits.findIndex(item => item.type === value.type);
    if (index >= 0) { const waiter = owner.waits.splice(index, 1)[0]; clearTimeout(waiter.timer); waiter.resolve(value); }
    else owner.pending.push(value);
  });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  socket.send(JSON.stringify({ type: 'join', roomKey: broker.roomKey, hostToken: broker.hostToken, name: 'Protocol fixture host' }));
  await owner.take('welcome'); return owner;
}
async function join(page, invite, owner, name, initial = false) {
  if (initial) { await page.goto(invite); await page.waitForFunction(() => document.getElementById('join-dialog').open); }
  else { await page.locator('#join-button').click(); await page.locator('#join-invite').fill(invite); }
  await page.locator('#join-name').fill(name); await page.locator('#join-submit').click();
  const request = await owner.take('join-request'); owner.socket.send(JSON.stringify({ type: 'approve', peerId: request.peerId }));
  await page.waitForFunction(() => !document.getElementById('share-button').disabled);
}
async function noCapture(page, count = 0) {
  const snapshot = await page.evaluate(() => ({ captures: qaMac.captures.length, microphones: qaMac.microphones,
    controls: qaMac.controls, settings: qaMac.settings.slice(), choices: qaMac.choices.slice() }));
  assert.equal(snapshot.captures, count); assert.equal(snapshot.microphones, 0); assert.equal(snapshot.controls, 0);
  assert.equal(await page.locator('#mic-button').getAttribute('aria-label'), 'Turn microphone on');
  return snapshot;
}
async function helpOpen(page) {
  await page.waitForFunction(() => document.getElementById('screen-access-dialog').open);
  const value = await page.locator('#screen-access-dialog').innerText();
  assert.match(value, /Glance-Port/); assert.match(value, /System Settings|Privacy|screen/i);
  assert.doesNotMatch(value, /auralink:|Error invoking remote method|Failed to get sources\./i);
  assert.equal(await page.locator('#screen-access-open-settings').isEnabled(), true);
  assert.equal(await page.locator('#screen-access-retry').isEnabled(), true);
  return value;
}
async function configure(page, value) { await page.evaluate(value => window.qaMacConfigure(value), value); }
async function leave(page) {
  await page.locator('#end-button').click();
  await page.waitForFunction(() => !document.getElementById('lobby').hidden && document.getElementById('session').hidden);
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  let broker, owner, browser, page, phase = 'setup'; const errors = [];
  const report = { passed: false,
    scope: 'Production renderer and local HTTPS admission; simulated native Mac bridge/TCC decisions; generated canvas screen only.',
    physicalMacTest: false, actualTCCChanged: false, actualNativeScreenCapture: false, realMicrophoneRequested: false,
    nativeInputPosted: false, checks: [] };
  try {
    const cert = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], { keySize: 2048, algorithm: 'sha256' });
    broker = await createBroker({ host: '127.0.0.1', name: 'Mac recovery UI fixture',
      tls: { key: cert.private, cert: cert.cert }, assetsDir: path.resolve(__dirname, '../src/renderer') });
    owner = await ownerFixture(broker);
    const invite = `${broker.url}/#key=${broker.roomKey}&fp=${fingerprint(cert.cert)}`;
    browser = await chromium.launch({ executablePath: browserPath, headless: true,
      args: ['--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 850 } });
    await context.addInitScript(({ failure, available }) => {
      const pending = new Map();
      window.qaMac = { sources: [], settings: [], choices: [], captures: [], microphones: 0, controls: 0,
        sourceQueue: [failure], captureQueue: [], settingsPending: false, nativeFailure: null };
      window.qaMacConfigure = values => Object.assign(qaMac, values);
      window.qaMacResolve = (id, value) => { const resolve = pending.get(id); if (!resolve) throw new Error(`No fixture pending ${id}`); pending.delete(id); resolve(value); };
      window.glancePort = { platform: 'darwin',
        async getInfo() { return { platform: 'darwin', version: '0.6.1', nativeControl: true, profileName: 'Glance-Port', applicationId: 'local.glanceport.desktop',
          permissions: { screen: 'denied', microphone: 'denied', accessibility: 'denied' }, screenCapture: qaMac.nativeFailure }; },
        async sources() {
          qaMac.sources.push(true); const next = qaMac.sourceQueue.shift() || available;
          if (next.pending) return new Promise(resolve => pending.set(next.pending, resolve));
          if (next.throw) throw new Error(next.throw); return next;
        },
        async chooseScreen(id) { qaMac.choices.push(id); return { ok: true }; },
        async openPermissionSettings(type) { qaMac.settings.push(type); if (qaMac.settingsPending) return new Promise(resolve => pending.set('settings', resolve)); return { ok: true }; },
        async requestMedia() { qaMac.microphones++; throw new Error('This check must never enable the microphone'); },
        async grantControl() { qaMac.controls++; throw new Error('This check must never grant native control'); },
        async stopSharing() { return { ok: true }; }, async revokeControl() { return { ok: true }; },
        async trustInvite() { return {}; }, async getPendingInvitation() { return null; },
        async setSessionActive() { return { active: false }; },
        async setPresentationFullscreen(active) { return { fullscreen: active }; } };
      navigator.mediaDevices.getUserMedia = async () => { qaMac.microphones++; throw new Error('Hardware capture is excluded from Mac recovery fixture'); };
      navigator.mediaDevices.getDisplayMedia = async constraints => {
        qaMac.captures.push(constraints); const next = qaMac.captureQueue.shift();
        if (next?.error) { qaMac.nativeFailure = next.nativeFailure || failure; throw new DOMException(next.error, 'NotAllowedError'); }
        const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
        const draw = canvas.getContext('2d'); let frame = 0;
        const paint = () => { draw.fillStyle = frame++ % 2 ? '#933448' : '#62481f'; draw.fillRect(0, 0, 640, 360);
          draw.fillStyle = '#fff'; draw.font = '24px sans-serif'; draw.fillText('Generated fixture screen ' + frame, 20, 80); };
        paint(); const timer = setInterval(paint, 70); const stream = canvas.captureStream(12);
        stream.getVideoTracks()[0].addEventListener('ended', () => clearInterval(timer)); return stream;
      };
    }, { failure, available });
    page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    phase = 'admit real room with media off'; await join(page, invite, owner, 'Mac recovery QA', true); await noCapture(page);
    phase = 'denied screen permission recovery'; await page.locator('#share-button').click(); report.permissionHelp = await helpOpen(page);
    await noCapture(page); assert.equal((await page.evaluate(() => qaMac.choices)).length, 0);
    await page.screenshot({ path: path.join(output, 'mac-screen-recovery-help.png') });
    phase = 'immediate repeated denial retains current recovery actions';
    await configure(page, { sourceQueue: [json(failure), json(failure)] });
    await page.evaluate(() => {
      window.qaCloseObservations = [];
      document.getElementById('screen-access-dialog').addEventListener('close', () => {
        qaCloseObservations.push({ reopened: document.getElementById('screen-access-dialog').open });
      }, { capture: true });
      document.getElementById('screen-access-retry').click();
    });
    await page.waitForFunction(() => qaMac.sources.length === 2 && qaCloseObservations.length > 0);
    await helpOpen(page);
    assert.ok(await page.evaluate(() => qaCloseObservations.some(value => value.reopened)),
      'The previous real dialog close event must be observed after immediate denied retry reopened help');
    await page.locator('#screen-access-retry').click();
    await page.waitForFunction(() => qaMac.sources.length === 3 && qaCloseObservations.length > 1);
    await helpOpen(page); await noCapture(page);
    report.delayedDialogClose = await page.evaluate(() => qaCloseObservations.slice());
    report.checks.push('Delayed previous-dialog close cannot invalidate immediately reopened denied-retry help');
    phase = 'explicit screen settings'; await page.locator('#screen-access-open-settings').click();
    await page.waitForFunction(() => qaMac.settings.length === 1); assert.deepEqual(await page.evaluate(() => qaMac.settings), ['screen']); await noCapture(page);
    phase = 'owner retry then explicit source selection'; await configure(page, { sourceQueue: [json(available)] }); await page.locator('#screen-access-retry').click();
    await page.waitForFunction(() => document.getElementById('screen-dialog').open);
    assert.equal(await page.evaluate(() => document.getElementById('screen-access-dialog').open), false);
    await noCapture(page); await page.locator('.screen-source').filter({ hasText: 'Generated QA display' }).click();
    await page.waitForFunction(() => document.getElementById('share-button').getAttribute('aria-label') === 'Stop sharing screen');
    await page.waitForFunction(() => { const video = document.getElementById('stage-video'); return !video.hidden && video.videoWidth === 640 && video.videoHeight === 360 && video.currentTime > 0; });
    assert.deepEqual(await page.evaluate(() => qaMac.choices), ['screen:qa']); await noCapture(page, 1);
    report.generatedScreen = await page.locator('#stage-video').evaluate(video => ({ width: video.videoWidth, height: video.videoHeight, currentTime: video.currentTime }));
    report.checks.push('Denied native screen result becomes useful permission help', 'Settings requires an explicit owner click', 'Retry returns chooser without capture', 'Explicit selected fixture display produces a real generated video track');
    await page.locator('#share-button').click(); await page.waitForFunction(() => document.getElementById('share-button').getAttribute('aria-label') === 'Share screen');
    phase = 'native enumeration failure and recovery cancellation';
    await configure(page, { sourceQueue: [{ ok: false, code: 'enumeration', status: 'granted', reason: 'Glance-Port could not list this Mac’s displays. Check Screen & System Audio Recording in System Settings, then retry.' }] });
    await page.locator('#share-button').click(); await helpOpen(page); await noCapture(page, 1);
    await page.locator('#screen-access-close').click(); assert.equal(await page.evaluate(() => document.getElementById('screen-access-dialog').open), false);
    await page.locator('#screen-access-retry').dispatchEvent('click'); await page.locator('#screen-access-open-settings').dispatchEvent('click');
    await noCapture(page, 1); assert.equal((await page.evaluate(() => qaMac.settings)).length, 1, 'Closed help cannot retain a settings action');
    phase = 'chooser cancellation'; await configure(page, { sourceQueue: [json(available)] }); await page.locator('#share-button').click();
    await page.waitForFunction(() => document.getElementById('screen-dialog').open); await page.locator('#screen-dialog [data-close]').click(); await noCapture(page, 1);
    await configure(page, { sourceQueue: [json(available.sources)] }); await page.locator('#share-button').click();
    await page.waitForFunction(() => document.getElementById('screen-dialog').open); await page.locator('#screen-dialog [data-close]').click(); await noCapture(page, 1);
    report.checks.push('Enumeration failure explains recovery without raw IPC names', 'Closing permission help invalidates hidden retry and settings handlers', 'Cancelling the chooser never captures');
    report.checks.push('Legacy source-array bridge remains compatible without automatic capture');
    phase = 'post-selection native capture permission failure';
    await configure(page, { sourceQueue: [json(available)], captureQueue: [{ error: 'Permission denied', nativeFailure: json(failure) }] });
    await page.locator('#share-button').click(); await page.waitForFunction(() => document.getElementById('screen-dialog').open);
    await page.locator('.screen-source').filter({ hasText: 'Generated QA display' }).click(); await helpOpen(page); await noCapture(page, 2);
    assert.equal(await page.locator('#share-button').getAttribute('aria-label'), 'Share screen');
    await configure(page, { sourceQueue: [json(available)], nativeFailure: null }); await page.locator('#screen-access-retry').click();
    await page.waitForFunction(() => document.getElementById('screen-dialog').open); await page.locator('#screen-dialog [data-close]').click(); await noCapture(page, 2);
    report.checks.push('Capture rejection after source choice retrieves structured native help', 'Capture refusal cleans up and permits another owner retry');
    phase = 'late source enumeration cannot enter replacement room';
    await configure(page, { sourceQueue: [json(failure)] }); await page.locator('#share-button').click(); await helpOpen(page);
    await configure(page, { sourceQueue: [{ pending: 'sources-old-room' }] }); const before = await page.evaluate(() => qaMac.sources.length);
    await page.locator('#screen-access-retry').click(); await page.waitForFunction(before => qaMac.sources.length > before, before);
    await leave(page); await join(page, invite, owner, 'Replacement QA');
    await page.evaluate(value => qaMacResolve('sources-old-room', value), available);
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => document.getElementById('screen-dialog').open || document.getElementById('screen-access-dialog').open), false);
    await noCapture(page, 2);
    phase = 'late settings completion cannot act in replacement room';
    await configure(page, { sourceQueue: [json(failure)], settingsPending: true }); await page.locator('#share-button').click(); await helpOpen(page);
    await page.locator('#screen-access-open-settings').click(); await page.waitForFunction(() => qaMac.settings.length === 2);
    await page.locator('#screen-access-close').click(); await leave(page); await join(page, invite, owner, 'Second replacement QA');
    const sourceCalls = await page.evaluate(() => qaMac.sources.length);
    await page.evaluate(() => qaMacResolve('settings', { ok: true })); await page.waitForTimeout(150);
    await page.locator('#screen-access-retry').dispatchEvent('click'); await page.locator('#screen-access-open-settings').dispatchEvent('click');
    assert.equal(await page.evaluate(() => qaMac.sources.length), sourceCalls); assert.equal((await page.evaluate(() => qaMac.settings)).length, 2);
    assert.equal(await page.evaluate(() => document.getElementById('screen-dialog').open || document.getElementById('screen-access-dialog').open), false); await noCapture(page, 2);
    report.checks.push('Room replacement invalidates pending retry source enumeration', 'Room replacement invalidates pending settings and hidden recovery actions');
    phase = 'finish'; await leave(page); report.calls = await page.evaluate(() => ({ sourceRequests: qaMac.sources.length, settings: qaMac.settings, chosenSources: qaMac.choices,
      generatedOrRejectedCaptureRequests: qaMac.captures.length, microphoneRequests: qaMac.microphones, nativeControlGrants: qaMac.controls }));
    assert.deepEqual(errors, []); report.errors = errors; report.passed = true;
  } catch (error) { report.error = error.stack || String(error); report.errors = errors; throw error; }
  finally {
    report.phase = phase; report.version = require('../package.json').version;
    report.sourceHashes = ['src/renderer/app.js', 'src/renderer/index.html'].map(file => ({ path: file, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.resolve(__dirname, '..', file))).digest('hex') }));
    fs.writeFileSync(path.join(output, 'mac-screen-recovery-browser.json'), JSON.stringify(report, null, 2));
    for (const waiter of owner?.waits || []) clearTimeout(waiter.timer);
    if (browser) await browser.close(); owner?.socket.close(); if (broker) await broker.stop();
  }
  console.log('Mac recovery browser checks passed: real renderer/room, simulated permissions, generated display; no Mac hardware permission or input.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
