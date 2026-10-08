'use strict';

// Real HTTPS/WebRTC/renderer with synthetic WAV microphone input. This verifies
// decoded audio energy and playback state, not a physical speaker or microphone.
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

function writeTone(file) {
  const sampleRate = 48000; const count = sampleRate * 2; const wav = Buffer.alloc(44 + count * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i++) wav.writeInt16LE(Math.round(Math.sin(i / sampleRate * Math.PI * 2 * 440) * 8000), 44 + i * 2);
  fs.writeFileSync(file, wav);
}
async function fixture(broker) {
  const ws = new WebSocket(broker.url.replace(/^http/, 'ws') + '/ws', { rejectUnauthorized: false });
  const owner = { ws, inbox: [], waiters: [] };
  owner.send = packet => ws.send(JSON.stringify(packet));
  owner.take = type => {
    const index = owner.inbox.findIndex(packet => packet.type === type);
    if (index >= 0) return Promise.resolve(owner.inbox.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { type, resolve }; waiter.timer = setTimeout(() => reject(new Error(`No ${type} received`)), 8000); owner.waiters.push(waiter);
    });
  };
  ws.on('message', raw => {
    const packet = JSON.parse(raw.toString()); if (packet.type === 'signal') return;
    const index = owner.waiters.findIndex(waiter => waiter.type === packet.type);
    if (index >= 0) { const waiter = owner.waiters.splice(index, 1)[0]; clearTimeout(waiter.timer); waiter.resolve(packet); }
    else owner.inbox.push(packet);
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  owner.send({ type: 'join', name: 'Audio protocol fixture', roomKey: broker.roomKey, hostToken: broker.hostToken }); await owner.take('welcome'); return owner;
}
async function join(page, invite, name, owner) {
  await page.goto(invite); await page.waitForFunction(() => document.getElementById('join-dialog').open);
  await page.locator('#join-name').fill(name); await page.locator('#join-submit').click();
  const pending = await owner.take('join-request'); owner.send({ type: 'approve', peerId: pending.peerId });
  await page.waitForFunction(() => !document.getElementById('mic-button').disabled);
  assert.equal(await page.evaluate(() => qaCaptureCalls.length), 0, 'Joining must leave microphone off');
}
async function proof(page) {
  await page.waitForFunction(() => [...document.querySelectorAll('audio[data-peer]')].some(audio => audio.srcObject?.getAudioTracks().length && !audio.paused && !audio.muted), undefined, { timeout: 20000 });
  return page.evaluate(async () => {
    const audio = [...document.querySelectorAll('audio[data-peer]')].find(audio => audio.srcObject);
    const context = new AudioContext(); await context.resume();
    const input = context.createMediaStreamSource(audio.srcObject); const analyser = context.createAnalyser(); analyser.fftSize = 512;
    input.connect(analyser); const samples = new Float32Array(512);
    const energy = await new Promise(resolve => {
      let iterations = 0; let maximum = 0;
      const timer = setInterval(() => {
        analyser.getFloatTimeDomainData(samples); maximum = Math.max(maximum, samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
        if (++iterations >= 10) { clearInterval(timer); resolve(maximum); }
      }, 80);
    });
    input.disconnect(); analyser.disconnect(); await context.close();
    return { paused: audio.paused, muted: audio.muted, readyState: audio.readyState, currentTime: audio.currentTime, decodedMeanSquareEnergy: energy };
  });
}
async function main() {
  const output = path.resolve(__dirname, '..', 'test-results'); fs.mkdirSync(output, { recursive: true });
  const wav = path.join(output, 'synthetic-microphone.wav'); writeTone(wav);
  let browser; let broker; let owner; let phase = 'setup'; const contexts = []; const errors = [];
  try {
    const cert = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], { keySize: 2048, algorithm: 'sha256' });
    broker = await createBroker({ host: '127.0.0.1', name: 'Audio QA', tls: { key: cert.private, cert: cert.cert }, assetsDir: path.resolve(__dirname, '..', 'src', 'renderer') });
    owner = await fixture(broker);
    browser = await chromium.launch({ executablePath: browserPath, headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${wav}`, '--autoplay-policy=user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
    const desktop = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1350, height: 900 }, permissions: ['microphone'] });
    const mobile = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, permissions: ['microphone'] });
    contexts.push(desktop, mobile);
    for (const context of contexts) await context.addInitScript(() => {
      window.qaCaptureCalls = []; const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async constraints => { qaCaptureCalls.push(constraints); return getUserMedia(constraints); };
      window.qaEndNextAudioDuringReplacement = false; window.qaEndedAudioTrack = null;
      const replaceTrack = RTCRtpSender.prototype.replaceTrack;
      RTCRtpSender.prototype.replaceTrack = async function (track) {
        if (qaEndNextAudioDuringReplacement && track?.kind === 'audio') {
          qaEndNextAudioDuringReplacement = false;
          await replaceTrack.call(this, track);
          // stop() deliberately does not emit ended; dispatch the event that
          // a hardware disconnect/privacy revocation sends during an await.
          qaEndedAudioTrack = track; track.stop(); track.dispatchEvent(new Event('ended'));
          await new Promise(resolve => setTimeout(resolve, 120)); return;
        }
        return replaceTrack.call(this, track);
      };
    });
    await desktop.addInitScript(() => localStorage.setItem('auralink.preferences', JSON.stringify({ microphone: 'missing-previous-microphone' })));
    await mobile.addInitScript(() => {
      window.qaAllowRemotePlayback = false; const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () { if (this.dataset.peer && !qaAllowRemotePlayback) return Promise.reject(new DOMException('Simulated browser autoplay block', 'NotAllowedError')); return play.call(this); };
    });
    const a = await desktop.newPage(); const b = await mobile.newPage();
    for (const page of [a, b]) page.on('pageerror', error => errors.push(error.message));
    await a.goto(broker.url); await a.screenshot({ path: path.join(output, 'desktop-lobby.png'), fullPage: true });
    const invite = `${broker.url}/#key=${broker.roomKey}&fp=${fingerprint(cert.cert)}`;
    phase = 'admission'; await join(a, invite, 'Desktop voice QA', owner); await join(b, invite, 'Phone voice QA', owner);
    phase = 'explicit microphone activation'; await a.locator('#mic-button').click(); await b.locator('#mic-button').click();
    for (const page of [a, b]) await page.waitForFunction(() => document.getElementById('mic-button').getAttribute('aria-label') === 'Turn microphone off', undefined, { timeout: 20000 });
    assert.equal(await a.evaluate(() => JSON.parse(localStorage.getItem('auralink.preferences')).microphone), '', 'Stale microphone preference should fall back to system default');
    assert.equal(await a.evaluate(() => qaCaptureCalls.length), 2, 'Stale microphone triggers one default retry');
    phase = 'input level';
    for (const page of [a, b]) await page.waitForFunction(() => document.getElementById('mic-level').value > .001, undefined, { timeout: 12000 });
    phase = 'persistent autoplay recovery'; await b.waitForFunction(() => !document.getElementById('audio-banner').hidden);
    await b.locator('#hear-room').click();
    await b.waitForFunction(() => !document.getElementById('audio-banner').hidden && document.getElementById('audio-banner-text').textContent.includes('Playback is still blocked'));
    assert.equal(await b.locator('#audio-banner').isVisible(), true, 'Failed replay must keep the Enable sound action visible');
    // Keep every late track/unmute retry blocked until the actual recovery
    // gesture. Lifting the fixture gate before click lets a retry hide the
    // action while Playwright is waiting for its layout to become stable.
    await b.evaluate(() => {
      document.getElementById('hear-room').addEventListener('click', () => { qaAllowRemotePlayback = true; }, { once: true, capture: true });
    });
    await b.locator('#hear-room').click(); await b.waitForFunction(() => document.getElementById('audio-banner').hidden);
    phase = 'decoded bidirectional audio'; const audio = [await proof(a), await proof(b)];
    assert.ok(audio.every(item => item.decodedMeanSquareEnergy > .000001), 'Both peers must decode real non-silent synthetic audio');
    for (const page of [a, b]) {
      await page.locator('#diagnostics-toggle').click();
      await page.waitForFunction(() => [...document.querySelectorAll('.stat-row')].some(row => /Audio received\d+ packets/.test(row.textContent)) && [...document.querySelectorAll('.stat-row')].some(row => /Audio codecaudio\/opus/.test(row.textContent)), undefined, { timeout: 12000 });
    }
    phase = 'off and restart'; await a.locator('#mic-button').click(); await a.waitForFunction(() => document.getElementById('mic-level').value === 0);
    await b.waitForFunction(() => ![...document.querySelectorAll('audio[data-peer]')].some(audio => audio.srcObject));
    phase = 'device ends while source is being attached';
    await a.evaluate(() => { qaEndNextAudioDuringReplacement = true; }); await a.locator('#mic-button').click();
    await a.waitForFunction(() => qaEndedAudioTrack?.readyState === 'ended' && !document.getElementById('mic-button').disabled && document.getElementById('mic-button').getAttribute('aria-label') === 'Turn microphone on' && document.getElementById('mic-level').value === 0 && !document.getElementById('voice-status').classList.contains('active'));
    await b.waitForFunction(() => ![...document.querySelectorAll('audio[data-peer]')].some(audio => audio.srcObject));
    const endedDuringAttachment = await a.evaluate(() => ({ readyState: qaEndedAudioTrack.readyState, microphoneOn: document.getElementById('mic-button').getAttribute('aria-label') === 'Turn microphone off', meter: document.getElementById('mic-level').value }));
    await a.locator('#mic-button').click(); await a.waitForFunction(() => document.getElementById('mic-button').getAttribute('aria-label') === 'Turn microphone off');
    const restarted = await proof(b); assert.ok(restarted.decodedMeanSquareEnergy > .000001);
    phase = 'sound test UI'; await b.locator('#audio-check-open').click();
    const capturesBefore = await b.evaluate(() => qaCaptureCalls.length);
    await b.locator('#test-microphone').click(); await b.waitForFunction(() => document.getElementById('test-mic-level').value > .001);
    assert.equal(await b.evaluate(() => qaCaptureCalls.length), capturesBefore, 'Testing an active microphone should reuse its capture');
    await b.locator('#test-speaker').click(); await b.waitForFunction(() => !document.getElementById('test-speaker').disabled);
    await b.locator('#audio-check-dialog [data-close]').click(); await b.waitForFunction(() => document.getElementById('test-mic-level').value === 0);
    await b.locator('#diagnostics-close').click(); await b.screenshot({ path: path.join(output, 'mobile-audio-room.png'), fullPage: true });
    assert.ok(await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    phase = 'teardown'; await a.locator('#end-button').click(); await b.locator('#end-button').click();
    for (const page of [a, b]) await page.waitForFunction(() => document.getElementById('session').hidden && ![...document.querySelectorAll('audio[data-peer]')].some(audio => audio.srcObject));
    assert.deepEqual(errors, []);
    const result = { passed: true, environment: 'Installed Chromium browser; localhost HTTPS broker; two real renderer clients; synthetic48kHz microphone WAV; simulated persistent autoplay rejection on mobile viewport',
      verified: ['no microphone on join', 'one safe system-default retry for stale microphone', 'input meters detect audio', 'persistent replay failure keeps Enable sound visible', 'explicit Enable sound recovery',
        'non-zero decoded audio energy in both directions', 'actual Opus and received packet diagnostics', 'mic off removes received stream', 'microphone ended during sender attachment leaves mic off and no remote stream', 'mic restart restores decoded sound', 'active microphone test reuses capture', 'speaker tone completes', 'leave releases audio', 'no horizontal overflow or JavaScript errors'],
      limitations: ['No physical microphone/speaker, Android WebView audio hardware or internet path tested', 'Capture disconnection is an injected lifecycle event on an actual synthetic input track'], audio, endedDuringAttachment, restarted, errors };
    fs.writeFileSync(path.join(output, 'audio-browser.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
  } catch (error) { throw new Error(`${phase}: ${error.stack}`); }
  finally { for (const context of contexts) await context.close().catch(() => {}); await browser?.close(); owner?.ws.terminate(); await broker?.stop(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
