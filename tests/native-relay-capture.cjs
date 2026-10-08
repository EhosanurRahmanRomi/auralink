'use strict';

// Actual production Electron source selection/getDisplayMedia track, followed
// by the shipped encrypted relay encoder/decoder. Packets stay in this renderer
// to isolate native capture from network/provider failures. No OS input or
// microphone access is requested and no screen images are saved.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { createHash } = require('node:crypto');
const { _electron } = require('playwright');

const root = path.resolve(__dirname, '..'), output = path.join(root, 'test-results');
const forceFallback = process.argv.includes('--force-reader-failure');
const reportName = forceFallback ? 'native-relay-capture-fallback.json' : 'native-relay-capture.json';

async function availablePort() {
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const profile = fs.mkdtempSync(path.join(output, 'native-relay-capture-profile-'));
  let application, page, phase = 'launch'; const errors = [];
  const proof = { passed: false, platform: process.platform, arch: process.arch, forcedReaderFailure: forceFallback,
    boundary: 'Actual production native app-window screen selection/getDisplayMedia; shipped relay encrypt/encode/decrypt/decode in one renderer. This verifies capture/codec interoperability, not a network route, physical microphone, remote OS input or macOS TCC on a different computer.',
    nativeScreenCapture: true, syntheticCapture: false, networkTest: false, microphoneRequested: false, osInputInjected: false, screenImagesSaved: false };
  try {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    application = await _electron.launch({ args: [root, '--smoke-test', `--user-data-dir=${profile}`, '--mute-audio', '--autoplay-policy=no-user-gesture-required'], env, timeout: 60000 });
    page = await application.firstWindow(); page.on('pageerror', error => errors.push(error.message));
    await page.locator('#host-button').waitFor();
    await page.locator('[data-view="settings"]').click(); await page.locator('#settings-quality').selectOption('1440'); await page.locator('#save-settings').click();
    await page.locator('[data-view="rooms"]').click(); await page.locator('.advanced-connections > summary').click(); await page.locator('#advanced-host-button').click();
    await page.locator('#host-mode').selectOption('nearby'); await page.locator('#host-name').fill('Native capture relay regression'); await page.locator('#host-port').fill(String(await availablePort()));
    await page.locator('#create-room').click(); await page.locator('#invite-dialog').waitFor({ state: 'visible' }); await page.locator('#invite-dialog [data-close]').click();
    phase = 'native app-window selection'; await page.locator('#share-button').click(); await page.locator('#screen-dialog').waitFor({ state: 'visible' });
    await page.locator('.screen-source').filter({ hasText: 'Glance-Port' }).first().click();
    await page.waitForFunction(() => document.getElementById('stage-video').videoWidth > 0, null, { timeout: 25000 });
    phase = 'native track encrypted codec relay';
    await page.evaluate(async forcedReaderFailure => {
      const { RelayMedia } = await import('./relay-media.js');
      const sourceStream = document.getElementById('stage-video').srcObject, track = sourceStream.getVideoTracks()[0];
      const secret = crypto.getRandomValues(new Uint8Array(32)); const key = btoa(String.fromCharCode(...secret)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const video = document.createElement('video'); video.id = 'native-relay-output'; video.muted = true; video.autoplay = true; video.playsInline = true;
      Object.assign(video.style, { position: 'fixed', bottom: '0', right: '0', width: '1px', height: '1px', opacity: '0' }); document.body.append(video);
      const canvas = document.createElement('canvas'); canvas.id = 'native-relay-motion'; canvas.width = 480; canvas.height = 180;
      Object.assign(canvas.style, { position: 'fixed', top: '80px', left: '280px', width: '480px', height: '180px', zIndex: '9999', pointerEvents: 'none' }); document.body.append(canvas);
      let paints = 0; const ctx = canvas.getContext('2d'); const motion = setInterval(() => {
        ctx.fillStyle = paints % 2 ? '#153c61' : '#25432a'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#a8f4d4'; ctx.fillRect(paints++ * 13 % 420, 40, 60, 90);
        ctx.font = '24px sans-serif'; ctx.fillStyle = '#ffffff'; ctx.fillText('Native screen frame ' + paints, 12, 30);
      }, 33);
      const events = []; let sender, receiver, envelopes = 0;
      const entry = () => ({ remoteState: {}, remoteTracks: new Map(), inactiveRemoteTracks: new Map() });
      const makeRTC = (selfId, peerId, localTracks, onTrack) => ({ selfId, quality: '1440', closed: false, peers: new Map([[peerId, entry()]]), localTracks,
        mediaState: () => ({ screen: localTracks.has('screen'), audio: false }),
        applyMediaState(id, state) { Object.assign(this.peers.get(id).remoteState, state); },
        emit(type, detail) { if (type === 'track') onTrack(detail); else if (type === 'error') events.push({ type, message: detail.error.message }); else if (type === 'relay-capture') events.push({ type, ...detail }); },
        signal(id, data) { envelopes++; if (selfId === 'native-source') receiver.receive('native-source', data.relay); else sender.receive('native-receiver', data.relay); return true; },
      });
      const sourceRTC = makeRTC('native-source', 'native-receiver', new Map([['screen', { track, stream: sourceStream }]]), () => {});
      const receiverRTC = makeRTC('native-receiver', 'native-source', new Map(), detail => { if (detail.kind === 'screen') { video.srcObject = detail.stream; void video.play(); } });
      const NativeProcessor = window.MediaStreamTrackProcessor;
      if (forcedReaderFailure) window.MediaStreamTrackProcessor = class { constructor() { throw new Error('Regression fixture: processor backend unavailable'); } };
      sender = new RelayMedia(sourceRTC, key); receiver = new RelayMedia(receiverRTC, key);
      sender.activate('native-receiver'); receiver.activate('native-source');
      window.nativeRelayQA = { track, sourceRTC, receiverRTC, sender, receiver, events, sourceSettings: track.getSettings(),
        counts: () => ({ envelopes, paints }),
        stop() { clearInterval(motion); sender.close(); receiver.close(); window.MediaStreamTrackProcessor = NativeProcessor; video.pause(); video.srcObject = null; video.remove(); canvas.remove(); } };
    }, forceFallback);
    await page.waitForFunction(() => nativeRelayQA.receiver.peers.get('native-source').frames >= 15 && document.getElementById('native-relay-output').videoWidth > 0, null, { timeout: 35000 });
    proof.media = await page.evaluate(async () => {
      const qa = nativeRelayQA, video = document.getElementById('native-relay-output'), source = qa.sender.sources.get('screen'), peer = qa.receiver.peers.get('native-source');
      const check = document.createElement('canvas'); check.width = 320; check.height = 180; const ctx = check.getContext('2d', { willReadFrequently: true });
      const hashes = new Set(), framesBefore = video.getVideoPlaybackQuality().totalVideoFrames, started = performance.now();
      for (let i = 0; i < 30; i++) {
        await new Promise(resolve => setTimeout(resolve, 100)); ctx.drawImage(video, 0, 0, 320, 180); const pixels = ctx.getImageData(0, 0, 320, 180).data;
        let hash = 2166136261; for (let offset = 0; offset < pixels.length; offset += 16) hash = Math.imul(hash ^ pixels[offset], 16777619); hashes.add(hash >>> 0);
      }
      return { sourceSettings: qa.sourceSettings, sourceReadyState: qa.track.readyState, sourceCaptureBackend: source.captureBackend,
        capturedFrames: source.capturedFrames, width: video.videoWidth, height: video.videoHeight, encodedWidth: source.width, encodedHeight: source.height,
        codec: peer.codec, receivedFrames: peer.frames, displayedFrames: video.getVideoPlaybackQuality().totalVideoFrames - framesBefore,
        measuredFPS: (video.getVideoPlaybackQuality().totalVideoFrames - framesBefore) / ((performance.now() - started) / 1000), changingFrameHashes: hashes.size,
        counts: qa.counts(), events: qa.events };
    });
    assert.equal(proof.media.sourceReadyState, 'live'); assert.equal(proof.media.width, proof.media.encodedWidth); assert.equal(proof.media.height, proof.media.encodedHeight);
    assert.ok(proof.media.width > 640 && proof.media.height > 360, 'Native capture must preserve useful presentation dimensions');
    assert.ok(['H.264', 'VP8'].includes(proof.media.codec), 'Native capture must use a negotiated real-time video codec');
    assert.ok(proof.media.displayedFrames >= 10 && proof.media.changingFrameHashes >= 2, 'Native captured motion must survive encode/decode and actual display: ' + JSON.stringify(proof.media));
    if (forceFallback) assert.ok(['Image capture', 'Video element'].includes(proof.media.sourceCaptureBackend), 'Forced processor failure must recover through an independent capture backend');
    assert.ok(!proof.media.events.some(event => event.type === 'error'), JSON.stringify(proof.media.events));
    phase = 'capture ownership and teardown';
    await page.evaluate(() => nativeRelayQA.stop());
    assert.equal(await page.evaluate(() => nativeRelayQA.track.readyState), 'live', 'Relay teardown must preserve the owner capture until Stop sharing');
    await page.locator('#share-button').click(); await page.waitForFunction(() => document.getElementById('stage-video').hidden);
    assert.equal(await page.evaluate(() => nativeRelayQA.track.readyState), 'ended');
    await page.locator('#end-button').click(); assert.deepEqual(errors, []); proof.passed = true;
    proof.sourceHashes = Object.fromEntries(['src/main.cjs', 'src/preload.cjs', 'src/renderer/app.js', 'src/renderer/relay-media.js'].map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
    fs.writeFileSync(path.join(output, reportName), JSON.stringify(proof, null, 2)); console.log(JSON.stringify(proof, null, 2));
  } catch (error) {
    proof.phase = phase; proof.error = error.message; proof.pageErrors = errors;
    proof.diagnostics = page ? await page.evaluate(() => ({ toast: document.getElementById('toast-region')?.textContent,
      capture: window.nativeRelayQA ? { source: nativeRelayQA.sender.sources.get('screen')?.captureBackend, settings: nativeRelayQA.sourceSettings, events: nativeRelayQA.events, frames: nativeRelayQA.receiver.peers.get('native-source')?.frames } : null })).catch(() => null) : null;
    fs.writeFileSync(path.join(output, reportName), JSON.stringify(proof, null, 2)); throw error;
  } finally {
    await application?.close(); const relative = path.relative(path.resolve(output), path.resolve(profile));
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Generated test profile must stay inside test-results');
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
