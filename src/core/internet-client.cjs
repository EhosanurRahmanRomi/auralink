'use strict';

const https = require('node:https');
const WebSocket = require('ws');

const MAX_BYTES = 65536;
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);

function internetOrigin(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x20\x7f\\?#]/.test(value) || !/^https:\/\/[^/]+\/?$/i.test(value)) throw new Error('Enter the HTTPS address of your internet service.');
  let url;
  try { url = new URL(value); } catch { throw new Error('Enter a complete HTTPS service address.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Use an HTTPS service address without credentials, paths or invitation fields.');
  return url.origin;
}

function probeInternetService(value, transport = https) {
  const origin = internetOrigin(value);
  return new Promise((resolve, reject) => {
    // Standard certificate-chain and hostname checks apply. No redirects or
    // LAN certificate pins are used for the separately configured service.
    const request = transport.get(`${origin}/internet/health`, { timeout: 10000, agent: false, rejectUnauthorized: true }, response => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error('This address is not an available Auralink internet service.')); return; }
      const chunks = []; let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 4096) { response.destroy(); reject(new Error('The service health response is invalid.')); return; }
        chunks.push(chunk);
      });
      response.once('end', () => {
        let health;
        try { health = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { reject(new Error('This address is not an Auralink internet service.')); return; }
        if (health?.service !== 'auralink-internet' || health.protocol !== 1 || health.status !== 'ok') { reject(new Error('This internet service uses an unsupported protocol.')); return; }
        resolve({ url: origin, socketUrl: origin.replace(/^https:/, 'wss:') + '/internet/ws', mode: 'internet' });
      });
      response.once('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('The internet service did not respond.')));
    request.on('error', () => reject(new Error('Could not verify the internet service certificate and connection.')));
  });
}

/** Native room identity is derived from the authenticated socket, never IPC. */
class InternetMembership {
  constructor(onRevoke = () => {}) { this.onRevoke = onRevoke; this.selfId = null; this.roomId = null; this.peers = new Set(); this.grant = null; }
  clear(reason = 'The internet room ended.') {
    const active = this.roomId !== null || this.grant !== null;
    this.selfId = null; this.roomId = null; this.peers.clear(); this.grant = null;
    if (active) this.onRevoke({ kind: 'room', reason });
  }
  revoke(reason) { this.grant = null; this.onRevoke({ kind: 'control', reason }); }
  observe(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return;
    if (message.type === 'welcome') {
      this.clear('The room changed.');
      if (!validId(message.selfId) || !validId(message.room?.id) || !Array.isArray(message.peers) || message.peers.length > 3) return;
      if (message.peers.some(peer => !validId(peer?.id) || peer.id === message.selfId)) return;
      this.selfId = message.selfId; this.roomId = message.room.id;
      for (const peer of message.peers) this.peers.add(peer.id);
    } else if (message.type === 'peer-joined' && this.roomId && validId(message.peer?.id) && message.peer.id !== this.selfId && this.peers.size < 3) {
      this.peers.add(message.peer.id);
    } else if (message.type === 'peer-left') {
      const peerId = message.peerId || message.id;
      this.peers.delete(peerId);
      if (this.grant?.peerId === peerId) this.revoke('The controller disconnected.');
    } else if (message.type === 'control-granted' && this.roomId && message.targetId === this.selfId && this.isAcceptedPeer(message.peerId) && validId(message.sessionId) && message.sessionId.length >= 16) {
      this.grant = { peerId: message.peerId, sessionId: message.sessionId };
    } else if (message.type === 'control-revoked' && (!message.sessionId || message.sessionId === this.grant?.sessionId)) {
      this.revoke('The room revoked control.');
    } else if (['room-left', 'room-ended', 'rejected'].includes(message.type)) {
      this.clear('The internet room ended.');
    }
  }
  isAcceptedPeer(id) { return Boolean(this.roomId && this.peers.has(id)); }
  isGrantConfirmed(peerId, sessionId) { return this.isAcceptedPeer(peerId) && this.grant?.peerId === peerId && this.grant.sessionId === sessionId; }
}

class NativeInternetClient {
  constructor(origin, socketId, emit, onRevoke, options = {}) {
    this.origin = internetOrigin(origin); this.socketId = socketId; this.emit = emit;
    this.membership = new InternetMembership(onRevoke); this.closed = false;
    this.admission = null;
    this.rateStart = Date.now(); this.rateCount = 0;
    const Socket = options.Socket || WebSocket;
    this.ws = new Socket(this.origin.replace(/^https:/, 'wss:') + '/internet/ws', {
      rejectUnauthorized: true, perMessageDeflate: false, maxPayload: MAX_BYTES, handshakeTimeout: 10000,
    });
    this.alive = true;
    this.ws.on('pong', () => { this.alive = true; });
    this.heartbeatTimer = setInterval(() => {
      if (this.closed || this.ws.readyState !== WebSocket.OPEN) return;
      if (!this.alive) {
        this.membership.clear('The internet connection stopped responding.');
        this.ws.terminate(); return;
      }
      this.alive = false; this.ws.ping();
    }, options.heartbeatMs || 20000);
    this.heartbeatTimer.unref();
    this.ws.on('open', () => { if (!this.closed) this.emit({ socketId, type: 'open' }); });
    this.ws.on('message', (raw, binary) => {
      if (this.closed) return;
      if (binary || raw.length > MAX_BYTES) { this.close(1008, 'Invalid service message.'); return; }
      let message;
      try { message = JSON.parse(raw.toString()); } catch { this.close(1008, 'Invalid service message.'); return; }
      if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.type !== 'string' || message.type.length > 64) { this.close(1008, 'Invalid service message.'); return; }
      if (message?.type === 'pending' && this.admission) {
        if (this.admission.roomId && message.room?.id !== this.admission.roomId) return;
        if (validId(message.selfId)) this.admission.selfId = message.selfId;
        if (validId(message.room?.id)) this.admission.roomId = message.room.id;
      }
      if (message?.type === 'welcome') {
        if (!this.admission || (this.admission.roomId && message.room?.id !== this.admission.roomId) ||
            (this.admission.selfId && message.selfId !== this.admission.selfId)) return;
        this.admission = null;
      }
      if (['room-left', 'room-ended', 'rejected', 'forgotten'].includes(message?.type)) this.admission = null;
      this.membership.observe(message);
      this.emit({ socketId, type: 'message', data: raw.toString() });
    });
    this.ws.on('error', () => {
      this.admission = null;
      this.membership.clear('The verified service connection failed.');
      if (!this.closed) this.emit({ socketId, type: 'error', message: 'The verified internet connection failed.' });
    });
    this.ws.on('close', (code, reason) => {
      clearInterval(this.heartbeatTimer);
      this.closed = true; this.membership.clear('The internet service disconnected.');
      this.admission = null;
      this.emit({ socketId, type: 'close', code, reason: String(reason).slice(0, 160) });
    });
  }
  send(data) {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) throw new Error('The internet connection is not open.');
    if (typeof data !== 'string' || Buffer.byteLength(data) > MAX_BYTES) throw new Error('Invalid internet message.');
    let message;
    try { message = JSON.parse(data); } catch { throw new Error('Internet messages must use JSON.'); }
    if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.type !== 'string') throw new Error('Invalid internet message.');
    if (Date.now() - this.rateStart > 5000) { this.rateStart = Date.now(); this.rateCount = 0; }
    if (++this.rateCount > 150) throw new Error('Too many internet requests.');
    if (['leave', 'join', 'join-device', 'create-room', 'forget'].includes(message.type)) {
      this.admission = ['join', 'join-device'].includes(message.type) ? { roomId: validId(message.roomId) ? message.roomId : null, selfId: null } : null;
      this.membership.clear('The room changed locally.');
    }
    this.ws.send(data);
  }
  close(code = 1000, reason = 'Closed locally.') {
    if (this.closed) return;
    this.closed = true; this.admission = null; clearInterval(this.heartbeatTimer); this.membership.clear(reason);
    this.ws.close(code, reason);
    const timer = setTimeout(() => this.ws.terminate(), 1500); timer.unref();
  }
}

module.exports = { internetOrigin, probeInternetService, InternetMembership, NativeInternetClient };
