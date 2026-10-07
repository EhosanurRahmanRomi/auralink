'use strict';

// Live account test. Credentials stay in memory and an ignored local secret file.
// This exercises the shipped native transport and membership policy, not native input.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { NativeInternetClient, probeInternetService } = require('../src/core/internet-client.cjs');

const PROJECT = path.resolve(__dirname, '..');
const ORIGIN = process.env.AURALINK_PUBLIC_ORIGIN || 'https://auralink-private-coordinator.auralink-internet-service.workers.dev';
const SECRET_FILE = process.env.AURALINK_SECRETS_FILE || path.join(PROJECT, '.private', 'internet-secrets.json');
const EVIDENCE_FILE = path.join(PROJECT, 'test-results', 'internet-public-native.json');
const WAIT_MS = 12000;

function endpoint(origin, name) {
  const messages = [], waits = [];
  const endpointState = { credentials: null, name, revocations: [], protocolPongs: 0 };
  const socketId = crypto.randomUUID();
  const transport = new NativeInternetClient(origin, socketId, event => {
    let message;
    if (event.type === 'message') {
      try { message = JSON.parse(event.data); } catch { message = { type: 'transport-invalid' }; }
      if (message.type === 'paired') endpointState.credentials = { deviceId: message.deviceId, deviceToken: message.deviceToken };
    } else message = { type: `transport-${event.type}`, code: event.code };
    const at = waits.findIndex(wait => wait.type === message.type && wait.accept(message));
    if (at >= 0) {
      const waiter = waits.splice(at, 1)[0]; clearTimeout(waiter.timer); waiter.resolve(message);
    } else messages.push(message);
  }, event => endpointState.revocations.push(event.kind));
  transport.ws.on('pong', () => { endpointState.protocolPongs++; });
  return Object.assign(endpointState, {
    transport,
    send(message) { transport.send(JSON.stringify(message)); },
    clear(type) { for (let i = messages.length - 1; i >= 0; i--) if (messages[i].type === type) messages.splice(i, 1); },
    next(type, accept = () => true, timeout = WAIT_MS) {
      const at = messages.findIndex(message => message.type === type && accept(message));
      if (at >= 0) return Promise.resolve(messages.splice(at, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { type, accept, resolve, timer: setTimeout(() => {
          const at = waits.indexOf(waiter); if (at >= 0) waits.splice(at, 1);
          reject(new Error('A required protocol event was not received.'));
        }, timeout) };
        waits.push(waiter);
      });
    },
    close() {
      for (const waiter of waits.splice(0)) clearTimeout(waiter.timer);
      transport.close(1000, 'Live QA test complete.');
    }
  });
}

async function forgetDevice(peer, origin) {
  if (!peer.credentials) { peer.close(); return true; }
  let cleanupPeer = peer;
  try {
    if (peer.transport.closed || peer.transport.ws.readyState !== 1) {
      cleanupPeer = endpoint(origin, peer.name);
      await cleanupPeer.next('transport-open');
      cleanupPeer.credentials = peer.credentials;
      cleanupPeer.send({ type: 'register', ...peer.credentials, name: peer.name });
      await cleanupPeer.next('registered', message => message.deviceId === peer.credentials.deviceId);
    }
    cleanupPeer.send({ type: 'forget' });
    const forgotten = await cleanupPeer.next('forgotten', message => message.deviceId === peer.credentials.deviceId);
    return Boolean(forgotten);
  } catch { return false; }
  finally { cleanupPeer.close(); if (cleanupPeer !== peer) peer.close(); }
}

async function main() {
  const report = { schema: 1, testedAt: new Date().toISOString(), origin: ORIGIN,
    executionPlatform: process.platform, sameWindowsPc: process.platform === 'win32',
    scope: 'Two native clients on one computer through the deployed public coordinator. No physical different-network or media/input test.',
    publicSignalingOnly: true, physicalDifferentNetworkTest: false, nativeInputInjected: false,
    pki: false, passed: false, flags: {}, cleanup: { hostForgotten: false, guestForgotten: false } };
  let stage = 'configuration'; let host = null, guest = null;
  try {
    const settings = JSON.parse(fs.readFileSync(SECRET_FILE, 'utf8'));
    const pairingKey = settings.PAIRING_KEY;
    assert.equal(typeof pairingKey, 'string'); assert.match(pairingKey, /^[A-Za-z0-9_-]{32,128}$/);
    stage = 'public-health-and-standard-tls';
    const probe = await probeInternetService(ORIGIN);
    assert.equal(probe.mode, 'internet'); report.origin = probe.url;
    const suffix = crypto.randomBytes(6).toString('hex');
    host = endpoint(probe.url, `QA native host ${suffix}`); guest = endpoint(probe.url, `QA native guest ${suffix}`);
    await Promise.all([host.next('transport-open'), guest.next('transport-open')]);
    assert.equal(host.transport.ws._socket.authorized, true);
    assert.equal(guest.transport.ws._socket.authorized, true);
    report.pki = true;

    stage = 'private-device-pairing-and-presence';
    host.send({ type: 'pair', pairingKey, name: host.name });
    guest.send({ type: 'pair', pairingKey, name: guest.name });
    await Promise.all([host.next('paired'), guest.next('paired')]);
    await Promise.all([host.next('registered'), guest.next('registered')]);
    const bothOnline = message => message.devices?.some(device => device.id === host.credentials.deviceId && device.online) &&
      message.devices?.some(device => device.id === guest.credentials.deviceId && device.online);
    await Promise.all([host.next('presence', bothOnline), guest.next('presence', bothOnline)]);
    report.flags.privatePairedPresence = true;

    stage = 'authenticated-room-owner';
    host.send({ type: 'create-room', name: 'Public native verification' });
    const room = await host.next('room-created');
    host.send({ type: 'join', roomId: room.roomId, roomKey: room.roomKey, hostToken: room.hostToken });
    const hostWelcome = await host.next('welcome');
    assert.equal(hostWelcome.selfId, hostWelcome.hostId); assert.equal(hostWelcome.room.id, room.roomId);
    assert.equal(hostWelcome.relayEnabled, false);
    assert.equal(host.transport.membership.roomId, room.roomId);
    assert.equal(host.transport.membership.selfId, hostWelcome.selfId);
    report.flags.authenticatedOwnerAndNativeMembership = true;
    report.flags.relayDisabled = true;

    stage = 'pending-admission-isolation';
    guest.send({ type: 'join-device', deviceId: host.credentials.deviceId });
    const pending = await guest.next('pending');
    const requested = await host.next('join-request', message => message.peerId === pending.selfId);
    assert.equal(requested.peerId, pending.selfId);
    assert.equal(guest.transport.membership.roomId, null);
    assert.equal(guest.transport.membership.isAcceptedPeer(hostWelcome.selfId), false);
    guest.send({ type: 'signal', to: hostWelcome.selfId, data: { verification: 'pending-must-not-forward' } });
    assert.match((await guest.next('error')).message, /approval/i);
    report.flags.pendingHasNoNativeMembershipOrSignaling = true;

    stage = 'owner-approved-native-membership';
    host.send({ type: 'approve', peerId: pending.selfId });
    const guestWelcome = await guest.next('welcome');
    await host.next('peer-joined', message => message.peer?.id === guestWelcome.selfId);
    assert.equal(guestWelcome.room.id, room.roomId);
    assert.equal(guestWelcome.hostId, hostWelcome.selfId);
    assert.equal(guest.transport.membership.selfId, guestWelcome.selfId);
    assert.equal(guest.transport.membership.roomId, room.roomId);
    assert.equal(guest.transport.membership.isAcceptedPeer(hostWelcome.selfId), true);
    assert.equal(host.transport.membership.isAcceptedPeer(guestWelcome.selfId), true);
    report.flags.ownerAdmissionAndExactNativeMembership = true;

    stage = 'server-derived-signal-sender';
    guest.send({ type: 'signal', from: 'forged-sender', to: hostWelcome.selfId, data: { verification: 'approved-sender-check' } });
    const signal = await host.next('signal', message => message.data?.verification === 'approved-sender-check');
    assert.equal(signal.from, guestWelcome.selfId);
    report.flags.senderIdentityDerivedFromAuthenticatedMembership = true;

    stage = 'independent-control-owner-consent';
    const sessionId = crypto.randomBytes(24).toString('base64url');
    assert.equal(host.transport.membership.isGrantConfirmed(guestWelcome.selfId, sessionId), false);
    guest.send({ type: 'control-request', to: hostWelcome.selfId });
    const request = await host.next('control-request', message => message.from === guestWelcome.selfId);
    await guest.next('control-pending', message => message.requestId === request.requestId);
    assert.equal(host.transport.membership.isGrantConfirmed(guestWelcome.selfId, sessionId), false);
    // A native owner consent dialog can remain open through coordinator hibernation.
    await new Promise(resolve => setTimeout(resolve, 25000));
    host.send({ type: 'control-response', to: guestWelcome.selfId, requestId: request.requestId, accepted: true, sessionId });
    const response = await guest.next('control-response', message => message.accepted === true && message.sessionId === sessionId);
    const grant = await host.next('control-granted', message => message.sessionId === sessionId);
    assert.equal(response.from, hostWelcome.selfId); assert.equal(grant.targetId, hostWelcome.selfId);
    assert.equal(grant.peerId, guestWelcome.selfId); assert.ok(grant.expiresAt > Date.now());
    assert.equal(host.transport.membership.isGrantConfirmed(guestWelcome.selfId, sessionId), true);
    assert.equal(host.transport.membership.isGrantConfirmed(hostWelcome.selfId, sessionId), false);
    assert.equal(host.transport.membership.isGrantConfirmed(guestWelcome.selfId, 'stale-session'), false);
    report.flags.independentOwnerConsentAndExactNativeGrant = true;
    report.flags.pendingOwnerConsentSurvivesHealthyIdle = true;

    stage = 'public-native-heartbeat-and-idle-control-lease';
    // Exercise the production20s protocol-ping watchdog against the real public endpoint.
    // No media/input is injected; the consent lease must remain confirmed during healthy idle.
    await new Promise(resolve => setTimeout(resolve, 23000));
    assert.ok(host.protocolPongs >= 1); assert.ok(guest.protocolPongs >= 1);
    assert.equal(host.transport.ws.readyState, 1); assert.equal(guest.transport.ws.readyState, 1);
    assert.equal(host.transport.membership.isGrantConfirmed(guestWelcome.selfId, sessionId), true);
    report.flags.publicNativeHeartbeatAndIdleControlLease = true;

    stage = 'revoke-and-replayed-control-response';
    host.send({ type: 'control-revoke', to: guestWelcome.selfId });
    await Promise.all([guest.next('control-revoke', message => message.sessionId === sessionId),
      host.next('control-revoked', message => message.sessionId === sessionId)]);
    assert.equal(host.transport.membership.isGrantConfirmed(guestWelcome.selfId, sessionId), false);
    assert.equal(host.transport.membership.grant, null);
    host.clear('error');
    host.send({ type: 'control-response', to: guestWelcome.selfId, requestId: request.requestId, accepted: true, sessionId });
    assert.match((await host.next('error')).message, /not found|expired/i);
    assert.equal(host.transport.membership.isGrantConfirmed(guestWelcome.selfId, sessionId), false);
    report.flags.revocationAndStaleGrantReplayRejected = true;

    stage = 'guest-leaves-room-directory-stays-online';
    guest.clear('presence');
    guest.send({ type: 'leave' }); await guest.next('room-left');
    await host.next('peer-left', message => message.peerId === guestWelcome.selfId);
    await guest.next('presence', bothOnline);
    assert.equal(guest.transport.membership.roomId, null); assert.equal(guest.transport.ws.readyState, 1);
    assert.equal(host.transport.membership.isAcceptedPeer(guestWelcome.selfId), false);
    guest.send({ type: 'ping' }); await guest.next('pong');
    report.flags.guestLeaveClearsMembershipKeepsDirectory = true;

    stage = 'host-leaves-room-directory-stays-online';
    host.clear('presence'); host.send({ type: 'leave' });
    await host.next('room-ended'); await host.next('room-left');
    await host.next('presence', message => bothOnline(message) &&
      message.devices.some(device => device.id === host.credentials.deviceId && !device.hosting));
    assert.equal(host.transport.membership.roomId, null); assert.equal(host.transport.ws.readyState, 1);
    report.flags.hostLeaveEndsRoomKeepsDirectory = true;
    report.passed = true;
  } catch {
    // Error text and assertion values can contain capabilities or peer identities.
    // Record only a fixed stage name; never print raw exceptions or protocol frames.
    report.failedStage = stage;
  } finally {
    if (guest) report.cleanup.guestForgotten = await forgetDevice(guest, report.origin);
    if (host) report.cleanup.hostForgotten = await forgetDevice(host, report.origin);
    if ((host && !report.cleanup.hostForgotten) || (guest && !report.cleanup.guestForgotten)) {
      report.passed = false; report.cleanupIncomplete = true;
    }
    fs.mkdirSync(path.dirname(EVIDENCE_FILE), { recursive: true });
    fs.writeFileSync(EVIDENCE_FILE, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.passed) process.exitCode = 1;
  }
}

main().catch(() => {
  process.stderr.write('Public native verification could not finish writing its sanitized evidence.\n');
  process.exitCode = 1;
});
