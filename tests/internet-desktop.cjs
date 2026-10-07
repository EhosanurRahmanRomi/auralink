'use strict';
// Opt-in live coordinator test of the actual Electron preload and native socket.
// The only captured window is Auralink itself. No OS input or hardware sensor is used.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { _electron } = require('playwright');
const { NativeInternetClient } = require('../src/core/internet-client.cjs');
const root = path.resolve(__dirname, '..');
const origin = process.env.AURALINK_PUBLIC_ORIGIN || 'https://auralink-private-coordinator.auralink-internet-service.workers.dev';
const secretFile = process.env.AURALINK_SECRETS_FILE || path.join(root, '.private/internet-secrets.json');
const proof = { passed: false, origin, scope: 'Actual isolated Electron renderer/preload/native WSS with one native guest on this PC; captures Auralink app window only.', physicalDifferentNetworkTest: false, nativeInputInjected: false };
async function main() {
  const pairingKey = JSON.parse(fs.readFileSync(secretFile, 'utf8')).PAIRING_KEY;
  const profile = fs.mkdtempSync(path.join(root, 'test-results/internet-desktop-profile-'));
  let application, guest; let phase = 'launch'; const queue = [], waiting = [];
  function take(type) {
    const at = queue.findIndex(value => value.type === type);
    if (at >= 0) return Promise.resolve(queue.splice(at, 1)[0]);
    return new Promise((resolve, reject) => { const timer = setTimeout(() => { const at = waiting.findIndex(value => value.resolve === resolve); if (at >= 0) waiting.splice(at, 1); reject(new Error('Protocol timeout')); }, 15000); waiting.push({ type, resolve, timer }); });
  }
  try {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    application = await _electron.launch({ args: [root, '--smoke-test', `--user-data-dir=${profile}`], env, timeout: 60000 });
    const page = await application.firstWindow(); let errors = 0; page.on('pageerror', () => errors++);
    await page.locator('#internet-settings-button').click();
    await page.locator('#internet-service').fill(origin); await page.locator('#internet-pairing-code').fill(pairingKey);
    await page.locator('#internet-go-online').click();
    await page.waitForFunction(() => document.getElementById('internet-status').textContent === 'Online');
    assert.equal(await page.locator('#internet-pairing-code').inputValue(), '');
    proof.actualNativeSocketPairing = true;
    guest = new NativeInternetClient(origin, 'desktop-qa-guest', event => {
      if (event.type !== 'message') return;
      const value = JSON.parse(event.data); const at = waiting.findIndex(item => item.type === value.type);
      if (at >= 0) { const item = waiting.splice(at, 1)[0]; clearTimeout(item.timer); item.resolve(value); } else queue.push(value);
    }, () => {});
    await new Promise((resolve, reject) => { guest.ws.once('open', resolve); guest.ws.once('error', reject); });
    guest.send(JSON.stringify({ type: 'pair', pairingKey, name: 'Electron integration guest' }));
    await take('registered');
    phase = 'create and admit'; await page.locator('.nav-item[data-view="rooms"]').click(); await page.locator('#host-button').click();
    await page.locator('#host-mode').selectOption('internet'); await page.locator('#host-name').fill('Electron Internet verification'); await page.locator('#create-room').click();
    await page.waitForFunction(() => document.getElementById('invite-dialog').open);
    const invite = new URL(await page.locator('#invite-value').inputValue()); const fields = new URLSearchParams(invite.hash.slice(1));
    await page.locator('#invite-dialog [data-close]').click();
    guest.send(JSON.stringify({ type: 'join', roomId: fields.get('room'), roomKey: fields.get('key') })); await take('pending');
    assert.equal(guest.membership.roomId, null);
    await page.waitForFunction(() => !document.getElementById('pending-banner').hidden);
    await page.locator('#review-requests').click(); await page.locator('#request-list').getByRole('button', { name: 'Accept', exact: true }).click(); await page.locator('#requests-dialog [data-close]').click();
    await take('welcome'); assert.ok(guest.membership.roomId); proof.actualNativeAdmission = true;
    phase = 'Auralink window capture'; await page.locator('#share-button').click();
    await page.locator('.screen-source').filter({ hasText: 'Auralink' }).first().click();
    await page.waitForFunction(() => { const video = document.getElementById('stage-video'); return !video.hidden && video.videoWidth > 0 && video.videoHeight > 0; }, null, { timeout: 20000 });
    proof.actualAppWindowCapture = await page.locator('#stage-video').evaluate(video => ({ width: video.videoWidth, height: video.videoHeight }));
    await page.locator('#share-button').click(); await page.waitForFunction(() => document.getElementById('stage-video').hidden);
    proof.captureStopped = true;
    phase = 'leave and cleanup'; await page.locator('#end-button').click(); await page.waitForFunction(() => document.getElementById('session').hidden);
    await take('room-ended'); assert.equal(guest.membership.roomId, null);
    assert.equal(await page.locator('#internet-status').textContent(), 'Online'); proof.leaveKeepsDirectory = true;
    guest.send(JSON.stringify({ type: 'forget' })); await take('forgotten'); proof.guestForgotten = true;
    await page.locator('.nav-item[data-view="settings"]').click(); await page.locator('#internet-forget').click();
    await page.waitForFunction(() => document.getElementById('internet-status').textContent === 'Offline'); proof.hostForgotten = true;
    assert.equal(errors, 0); proof.passed = true;
  } catch { proof.failedStage = phase; process.exitCode = 1; }
  finally {
    if (guest && !proof.guestForgotten && !guest.closed) { try { guest.send(JSON.stringify({ type: 'forget' })); await take('forgotten'); proof.guestForgotten = true; } catch {} }
    guest?.close(); for (const item of waiting) clearTimeout(item.timer);
    if (application) {
      if (!proof.hostForgotten) { try { const page = await application.firstWindow(); await page.locator('.nav-item[data-view="settings"]').click(); await page.locator('#internet-forget').click(); await page.waitForFunction(() => document.getElementById('internet-status').textContent === 'Offline'); proof.hostForgotten = true; } catch {} }
      await application.close();
    }
    proof.testedAt = new Date().toISOString();
    fs.writeFileSync(path.join(root, 'test-results/internet-desktop.json'), JSON.stringify(proof, null, 2)); console.log(JSON.stringify(proof, null, 2));
    const resolved = fs.realpathSync(profile), results = fs.realpathSync(path.join(root, 'test-results'));
    if (resolved.startsWith(results + path.sep) && path.basename(resolved).startsWith('internet-desktop-profile-')) fs.rmSync(resolved, { recursive: true, force: true });
  }
}
main().catch(() => { console.error('Live desktop verification could not complete; private details withheld.'); process.exitCode = 1; });
