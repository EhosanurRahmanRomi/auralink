'use strict';

// Integration verification only. Synthetic media, localhost and a real browser.
// This intentionally does not capture a physical microphone/camera or invoke native input.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');
const selfsigned = require('selfsigned');
const { chromium } = require('playwright');
const { createBroker } = require('../src/core/broker.cjs');

const browserCandidates = [process.env.AURALINK_TEST_BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/chromium', '/usr/bin/google-chrome'].filter(Boolean);
const browserPath = browserCandidates.find(file => fs.existsSync(file));
if (!browserPath) throw new Error('Install a supported browser or set AURALINK_TEST_BROWSER; no browser is downloaded by this test.');

function openClient(broker) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(broker.url.replace(/^http/, 'ws') + '/ws', { rejectUnauthorized: false });
    const client = { ws, inbox: [], waits: [], signals: [], page: null, ready: false, chain: Promise.resolve() };
    client.send = message => ws.send(JSON.stringify(message));
    client.take = type => {
      const index = client.inbox.findIndex(message => message.type === type);
      if (index >= 0) return Promise.resolve(client.inbox.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { type, resolve };
        waiter.timer = setTimeout(() => { client.waits = client.waits.filter(item => item !== waiter); reject(new Error(`Timed out waiting for ${type}.`)); }, 4000);
        client.waits.push(waiter);
      });
    };
    client.deliver = message => {
      client.chain = client.chain.then(() => client.page.evaluate(message => window.rtc.receive(message.from, message.data), message));
    };
    ws.on('message', raw => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'signal') { if (client.ready) client.deliver(message); else client.signals.push(message); return; }
      const index = client.waits.findIndex(item => item.type === message.type);
      if (index >= 0) { const [waiter] = client.waits.splice(index, 1); clearTimeout(waiter.timer); waiter.resolve(message); }
      else client.inbox.push(message);
    });
    ws.once('open', () => resolve(client)); ws.on('error', reject);
  });
}

async function waitFor(page, predicate, arg, description) {
  try { await page.waitForFunction(predicate, arg, { timeout: 15000 }); }
  catch (error) {
    const details = await page.evaluate(async () => ({ events: window.rtcEvents,
      videos: [...document.querySelectorAll('video')].map(video => ({ id: video.id, width: video.videoWidth, height: video.videoHeight, ready: video.readyState, paused: video.paused })),
      stats: await window.rtc.stats(),
      peers: [...window.rtc.peers].map(([id, entry]) => ({ id, state: entry.pc.connectionState,
        signaling: entry.pc.signalingState, kinds: [...entry.remoteTracks.keys()] })) }));
    throw new Error(`${description}: ${error.message}\n${JSON.stringify(details)}`);
  }
}

async function main() {
  let broker, browser;
  const clients = []; const contexts = [];
  try {
    const cert = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], { keySize: 2048, algorithm: 'sha256' });
    broker = await createBroker({ host: '127.0.0.1', name: 'RTC integration', tls: { key: cert.private, cert: cert.cert },
      assetsDir: path.join(__dirname, '..', 'src', 'renderer') });
    const host = await openClient(broker); clients.push(host);
    host.send({ type: 'join', name: 'Alpha', roomKey: broker.roomKey, hostToken: broker.hostToken });
    host.welcome = await host.take('welcome'); host.id = host.welcome.selfId; host.name = 'Alpha';
    for (const name of ['Bravo', 'Charlie']) {
      const client = await openClient(broker); clients.push(client); client.name = name;
      client.send({ type: 'join', name, roomKey: broker.roomKey });
      const pending = await client.take('pending'); client.id = pending.selfId;
      host.send({ type: 'approve', peerId: client.id });
      client.welcome = await client.take('welcome');
    }
    browser = await chromium.launch({ executablePath: browserPath, headless: true,
      args: ['--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
    for (const client of clients) {
      const context = await browser.newContext({ ignoreHTTPSErrors: true }); contexts.push(context);
      const page = await context.newPage(); client.page = page;
      await page.exposeFunction('sendSignal', (to, data) => client.send({ type: 'signal', to, data }));
      await page.goto(broker.url + '/health');
      await page.evaluate(async ({ id }) => {
        const { RoomRTC } = await import('/rtc.js');
        window.rtcEvents = { tracks: [], removed: [], data: [], connections: [], errors: [] };
        window.rtc = new RoomRTC({ selfId: id, signal: (to, data) => window.sendSignal(to, data), iceServers: [] });
        rtc.addEventListener('data', event => rtcEvents.data.push(event.detail));
        rtc.addEventListener('connection', event => rtcEvents.connections.push(event.detail));
        rtc.addEventListener('error', event => rtcEvents.errors.push({ peerId: event.detail.peerId, message: event.detail.error?.message }));
        rtc.addEventListener('track', event => {
          const { peerId, kind, track, stream } = event.detail;
          rtcEvents.tracks.push({ peerId, kind, trackId: track.id });
          const id = `media-${peerId}-${kind}`;
          let video = document.getElementById(id);
          if (!video) { video = document.createElement('video'); video.id = id; video.autoplay = true; video.muted = true; document.body.appendChild(video); }
          video.srcObject = stream; void video.play().catch(() => {});
        });
        rtc.addEventListener('track-removed', event => {
          rtcEvents.removed.push(event.detail);
          const video = document.getElementById(`media-${event.detail.peerId}-${event.detail.kind}`);
          if (video) { video.srcObject = null; video.remove(); }
        });
      }, { id: client.id });
    }
    const peerList = clients.map(client => ({ id: client.id, name: client.name, role: client === host ? 'host' : 'guest' }));
    for (const client of clients) await client.page.evaluate(peers => peers.forEach(peer => rtc.addPeer(peer)), peerList);
    for (const client of clients) { client.ready = true; for (const message of client.signals.splice(0)) client.deliver(message); }
    for (const client of clients) await waitFor(client.page,
      () => rtc.peers.size === 2 && [...rtc.peers.values()].every(entry => entry.pc.connectionState === 'connected' && entry.channel?.readyState === 'open'),
      undefined, 'Three-person peer mesh did not establish');

    // Data is bound to its authenticated RTC transport, regardless of packet claims.
    const [alpha, bravo, charlie] = clients;
    await bravo.page.evaluate(({ to, forgedId }) => rtc.sendData(to, { type: 'input', peerId: forgedId,
      sessionId: 'synthetic-only-session-00001', event: { type: 'move', seq: 1, x: 0.2, y: 0.3 } }), { to: alpha.id, forgedId: charlie.id });
    await waitFor(alpha.page, id => rtcEvents.data.some(item => item.peerId === id), bravo.id, 'Input-shaped data did not arrive');
    const receivedData = await alpha.page.evaluate(() => rtcEvents.data.at(-1));
    assert.equal(receivedData.peerId, bravo.id); assert.equal(receivedData.data.peerId, charlie.id);

    // A changing canvas generates genuine encoded/decode video, not a mocked stats row.
    await alpha.page.evaluate(async () => {
      const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
      const draw = canvas.getContext('2d'); let frame = 0;
      const paint = () => {
        draw.fillStyle = '#11223e'; draw.fillRect(0, 0, canvas.width, canvas.height);
        draw.fillStyle = '#26dcb7'; draw.fillRect((frame * 11) % 1000, 180, 260, 260);
        draw.fillStyle = '#ffffff'; draw.font = '48px sans-serif'; draw.fillText(`Synthetic 720p frame ${frame++}`, 70, 95);
      };
      paint(); window.syntheticTimer = setInterval(paint, 65);
      const stream = canvas.captureStream(15); await rtc.setTrack('camera', stream.getVideoTracks()[0], stream);
      window.syntheticAudio = new AudioContext(); await syntheticAudio.resume();
      const oscillator = syntheticAudio.createOscillator(); oscillator.frequency.value = 220;
      const destination = syntheticAudio.createMediaStreamDestination(); oscillator.connect(destination); oscillator.start();
      await rtc.setTrack('audio', destination.stream.getAudioTracks()[0], destination.stream);
    });
    for (const receiver of [bravo, charlie]) await waitFor(receiver.page, id => {
      const video = document.getElementById(`media-${id}-camera`);
      return video?.videoWidth > 0 && video.videoHeight > 0 && video.readyState >= 2;
    }, alpha.id, 'Receiver did not decode genuine adaptive camera frames');
    const decoded = [];
    for (const receiver of [bravo, charlie]) {
      const stats = await receiver.page.evaluate(async id => {
        const report = await rtc.peers.get(id).pc.getStats(); const inbound = [];
        report.forEach(row => { if (row.type === 'inbound-rtp' && row.kind === 'video') inbound.push({ width: row.frameWidth, height: row.frameHeight, decoded: row.framesDecoded, received: row.bytesReceived }); });
        return inbound;
      }, alpha.id);
      assert.ok(stats.some(row => row.width > 0 && row.height > 0 && row.decoded > 0 && row.received > 0));
      decoded.push({ receiver: receiver.name, inbound: stats });
    }

    // Verify that muting and unmuting the same track restores audio in both receivers.
    await alpha.page.evaluate(() => {
      rtc.localTracks.get('audio').track.enabled = false;
      for (const peerId of rtc.peers.keys()) rtc.send(peerId, { mediaState: rtc.mediaState() });
    });
    for (const receiver of [bravo, charlie]) await waitFor(receiver.page,
      id => rtcEvents.removed.some(event => event.peerId === id && event.kind === 'audio'), alpha.id, 'Mute state was not applied');
    await alpha.page.evaluate(() => {
      rtc.localTracks.get('audio').track.enabled = true;
      for (const peerId of rtc.peers.keys()) rtc.send(peerId, { mediaState: rtc.mediaState() });
    });
    for (const receiver of [bravo, charlie]) await waitFor(receiver.page,
      id => Boolean(rtc.peers.get(id).remoteTracks.get('audio')) && rtcEvents.tracks.filter(event => event.peerId === id && event.kind === 'audio').length >= 2,
      alpha.id, 'Unmuting the same audio track failed to restore remote media');

    // End one media source and prove the remaining peer connections remain available.
    await alpha.page.evaluate(async () => {
      const old = rtc.localTracks.get('camera'); await rtc.setTrack('camera', null); old.track.stop(); clearInterval(syntheticTimer);
    });
    for (const receiver of [bravo, charlie]) await waitFor(receiver.page,
      id => !rtc.peers.get(id).remoteTracks.has('camera'), alpha.id, 'Stopped camera remained visible');
    for (const client of clients) {
      const errors = await client.page.evaluate(() => rtcEvents.errors);
      assert.deepEqual(errors, [], `${client.name} emitted WebRTC errors`);
    }
    const result = { passed: true, environment: 'Three headless browser peers on this PC over localhost HTTPS; synthetic media only',
      source: '1280x720 synthetic canvas; received dimensions are measured, not guaranteed',
      verified: ['three-peer mesh', 'transport-bound input-shaped data; no native injection', 'actual decoded adaptive video frames', 'audio mute/unmute restoration', 'media teardown'], decoded };
    const outputDir = path.resolve(__dirname, '..', 'test-results');
    await fs.promises.mkdir(outputDir, { recursive: true });
    await fs.promises.writeFile(path.join(outputDir, 'rtc-browser.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally {
    for (const client of clients) {
      try { if (client.page && !client.page.isClosed()) await client.page.evaluate(async () => { if (window.syntheticTimer) clearInterval(syntheticTimer); window.rtc?.close(); if (window.syntheticAudio) await syntheticAudio.close(); }); } catch {}
      client.ws.terminate();
    }
    for (const context of contexts) await context.close().catch(() => {});
    await browser?.close(); await broker?.stop();
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
