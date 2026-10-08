// Explicit live smoke test. Creates one disposable public room, three ephemeral
// socket identities and one consent lease. Never prints invitation/key material.
import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
const require = createRequire(import.meta.url);
const { NativeInternetClient, probeInternetService, internetOrigin } = require('../../src/core/internet-client.cjs');
const DEFAULT_ORIGIN = 'https://auralink-private-coordinator.auralink-internet-service.workers.dev';

class Endpoint {
  constructor(origin) {
    this.messages = []; this.waiters = []; this.history = []; this.closed = false; this.publicConnectionLimit = false;
    this.client = new NativeInternetClient(origin, randomBytes(12).toString('base64url'), event => {
      if (event.type === 'message') { const message = JSON.parse(event.data); this.history.push(message); this.deliver(message); }
      else {
        if (event.type === 'close' && event.code === 1008 && event.reason === 'Public connection limit reached. Try again later.') this.publicConnectionLimit = true;
        this.deliver({ type: 'transport-' + event.type });
      }
    }, () => {});
  }
  deliver(message) {
    const at = this.waiters.findIndex(waiter => waiter.type === message.type);
    if (at >= 0) { const waiter = this.waiters.splice(at, 1)[0]; clearTimeout(waiter.timer); waiter.resolve(message); }
    else this.messages.push(message);
  }
  next(type) {
    const at = this.messages.findIndex(message => message.type === type);
    if (at >= 0) return Promise.resolve(this.messages.splice(at, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { type, resolve, timer: setTimeout(() => { this.waiters.splice(this.waiters.indexOf(waiter), 1); reject(new Error('Live check timed out.')); }, 12000) };
      this.waiters.push(waiter);
    });
  }
  send(message) { this.client.send(JSON.stringify(message)); }
  raw(message) { this.client.ws.send(JSON.stringify(message)); }
  close() { this.closed = true; for (const waiter of this.waiters) clearTimeout(waiter.timer); this.client.close(1000, 'Live smoke test finished.'); }
}
function check(value) { if (!value) throw new Error('Live service assertion failed.'); }

export async function runDeployedSmoke(origin = DEFAULT_ORIGIN) {
  const endpoints = [], proof = { status: 'running', checkedAt: new Date().toISOString(), service: internetOrigin(origin), checks: {} };
  let stage = 'health';
  try {
    await probeInternetService(origin); proof.checks.standardHttpsHealth = true;
    stage = 'landing'; const response = await fetch(origin, { redirect: 'error' });
    check(response.status === 200 && response.headers.get('Referrer-Policy') === 'no-referrer' &&
      response.headers.get('Content-Security-Policy')?.includes("connect-src 'none'")); proof.checks.invitationLanding = true;
    const connect = async name => {
      const endpoint = new Endpoint(origin); endpoints.push(endpoint); await endpoint.next('transport-open');
      endpoint.send({ type: 'bootstrap', name }); check((await endpoint.next('registered')).mode === 'public'); return endpoint;
    };
    stage = 'bootstrap'; const host = await connect('Disposable smoke owner'), guest = await connect('Disposable smoke guest');
    const outsider = await connect('Disposable unadmitted identity'); proof.checks.publicBootstrapWithoutCredentials = true;
    stage = 'host-room'; host.send({ type: 'create-room', name: 'Disposable verification room' }); const room = await host.next('room-created');
    host.send({ ...room, type: 'join' }); const owner = await host.next('welcome');
    check(owner.websocketRelayEnabled === true && owner.relayEnabled === false && owner.room.access === 'invite');
    check(owner.websocketRelayLimits?.dailyMessages === 300000 && owner.websocketRelayLimits?.reservationBytes === 2097152);
    stage = 'auto-admission'; guest.send({ type: 'join', roomId: room.roomId, roomKey: room.roomKey }); const admitted = await guest.next('welcome');
    await host.next('peer-joined'); check(admitted.relayKey === owner.relayKey && admitted.room.id === room.roomId &&
      !guest.history.some(message => ['pending', 'presence', 'paired'].includes(message.type))); proof.checks.invitationAutomaticEntry = true;
    stage = 'client-encryption'; const source = await readFile(new URL('../../src/renderer/relay-media.js', import.meta.url), 'utf8');
    const { RelayCipher } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
    const ownerCipher = new RelayCipher(owner.relayKey, owner.selfId, admitted.selfId), guestCipher = new RelayCipher(owner.relayKey, admitted.selfId, owner.selfId);
    const payload = new Uint8Array(randomBytes(8192));
    const envelope = await guestCipher.seal(payload);
    guest.send({ type: 'signal', to: owner.selfId, data: { relay: envelope } }); const forwarded = await host.next('signal');
    check(forwarded.from === admitted.selfId && Object.keys(forwarded).sort().join(',') === 'data,from,type');
    check(Buffer.from(await ownerCipher.open(forwarded.data.relay)).equals(Buffer.from(payload)));
    const answer = await ownerCipher.seal(payload); host.send({ type: 'signal', to: admitted.selfId, data: { relay: answer } });
    check(Buffer.from(await guestCipher.open((await guest.next('signal')).data.relay)).equals(Buffer.from(payload)));
    proof.checks.productionClientEncryptedDuplexPackets = true;
    stage = 'unadmitted-denial'; outsider.raw({ type: 'signal', to: owner.selfId, data: { relay: envelope } });
    check(/approval|admission/i.test((await outsider.next('error')).message)); proof.checks.serverRequiresReadyMembership = true;
    stage = 'independent-control'; guest.send({ type: 'control-request', to: owner.selfId }); const request = await host.next('control-request');
    const sessionId = randomBytes(24).toString('base64url');
    host.send({ type: 'control-response', to: admitted.selfId, requestId: request.requestId, accepted: true, sessionId });
    check((await guest.next('control-response')).accepted === true); await host.next('control-granted');
    check(host.client.membership.isGrantConfirmed(admitted.selfId, sessionId));
    host.send({ type: 'control-revoke', to: admitted.selfId }); check((await guest.next('control-revoke')).sessionId === sessionId);
    await host.next('control-revoked'); check(host.client.membership.grant === null); proof.checks.independentOwnerControlAndRevoke = true;
    stage = 'block'; host.send({ type: 'block', peerId: admitted.selfId }); await guest.next('rejected'); await host.next('peer-blocked'); await host.next('invite-disabled');
    check(guest.client.membership.roomId === null && !host.client.membership.isAcceptedPeer(admitted.selfId));
    let nativeRejected = false; try { guest.send({ type: 'signal', to: owner.selfId, data: { relay: envelope } }); } catch { nativeRejected = true; }
    check(nativeRejected); guest.raw({ type: 'signal', to: owner.selfId, data: { relay: envelope } });
    check(/approval|admission/i.test((await guest.next('error')).message)); proof.checks.removalRevokesNativeAndServerForwarding = true;
    stage = 'rotation'; host.send({ type: 'rotate-invite' }); const changed = await host.next('invite-updated'); check(changed.roomKey !== room.roomKey);
    guest.send({ type: 'join', roomId: room.roomId, roomKey: room.roomKey }); check(/Invalid invitation/i.test((await guest.next('error')).message));
    guest.send({ type: 'join', roomId: room.roomId, roomKey: changed.roomKey }); check(/blocked/i.test((await guest.next('error')).message));
    outsider.send({ type: 'join', roomId: changed.roomId, roomKey: changed.roomKey }); await outsider.next('welcome'); await host.next('peer-joined');
    proof.checks.oldInvitationBurnedAndCurrentConnectionBlocked = true;
    stage = 'cleanup'; host.send({ type: 'leave' }); await outsider.next('room-ended'); await host.next('room-left');
    check(host.client.membership.roomId === null && outsider.client.membership.roomId === null); proof.checks.ownerLeaveEndsRoom = true;
    ownerCipher.close(); guestCipher.close(); proof.status = 'passed';
    proof.boundary = 'Real public HTTPS/WSS packet and permission test. No physical media playback, native input injection or distinct-device/network claim.';
  } catch {
    proof.status = 'failed'; proof.failedStage = stage;
    proof.publicConnectionLimit = endpoints.some(endpoint => endpoint.publicConnectionLimit);
    proof.error = 'Live service verification failed. No credentials or invitations are included in this report.';
  }
  finally { for (const endpoint of endpoints) endpoint.close(); }
  return proof;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const origin = process.argv[2] || DEFAULT_ORIGIN, output = resolve(process.argv[3] || '../test-results/internet-deployed-smoke.json');
  const proof = await runDeployedSmoke(origin); await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(proof, null, 2) + '\n');
  process.stdout.write(JSON.stringify(proof, null, 2) + '\n'); if (proof.status !== 'passed') process.exitCode = 1;
}
