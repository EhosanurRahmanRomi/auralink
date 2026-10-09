'use strict';

const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocketServer, WebSocket } = require('ws');

const MAX_PARTICIPANTS = 4;
const MAX_PENDING = 8;
const MAX_MESSAGE_BYTES = 64 * 1024;
const JOIN_TIMEOUT_MS = 5000;
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.wasm': 'application/wasm',
};

function randomSecret() { return crypto.randomBytes(32).toString('base64url'); }
function isLoopback(address = '') {
  return address === 'localhost' || address === '::1' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(address) || /^::ffff:127\./.test(address);
}
function secretMatches(received, expected) {
  if (typeof received !== 'string' || received.length > 256) return false;
  const a = Buffer.from(received); const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function cleanName(value) {
  if (typeof value !== 'string') return null;
  const name = value.normalize('NFKC').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069<>]/g, '')
    .replace(/\s+/g, ' ').trim().slice(0, 48);
  return name || null;
}
function send(ws, payload) {
  if (ws.readyState !== WebSocket.OPEN) return;
  try { ws.send(JSON.stringify(payload)); } catch { /* A closing socket is handled by its close event. */ }
}

/**
 * Create a peer-hosted signaling room. Media never passes through this service.
 * Only an independently authenticated, local host can admit participants.
 * Invitations must carry roomKey in their fragment, then in the first WS frame.
 * hostToken must never be included in an invitation, URL, asset, or public response.
 */
async function createBroker(options = {}) {
  const { port = 0, host = '0.0.0.0', tls, assetsDir } = options;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('Invalid port.');
  if (!tls && !isLoopback(host)) throw new Error('TLS is required for a non-loopback listener.');
  if (tls && (!tls.key || !tls.cert)) throw new Error('TLS key and certificate are required.');
  if (options.hostToken !== undefined && (typeof options.hostToken !== 'string' || options.hostToken.length < 32)) {
    throw new Error('Host authentication token must be at least 32 characters.');
  }
  const hostToken = options.hostToken || randomSecret();
  const roomKey = randomSecret();
  const roomId = crypto.randomUUID();
  const roomName = cleanName(options.name) || 'Glance-Port room';
  const admissionTimeoutMs = options.admissionTimeoutMs ?? 60000;
  if (!Number.isInteger(admissionTimeoutMs) || admissionTimeoutMs < 100 || admissionTimeoutMs > 60000) {
    throw new TypeError('Admission timeout must be between 100 and 60000 milliseconds.');
  }
  const assetsRoot = assetsDir ? await fs.promises.realpath(path.resolve(assetsDir)) : null;
  const accepted = new Map();
  const pending = new Map();
  const sockets = new Set();
  const controlRequests = new Map();
  const controllers = new Map();
  let hostId = null;
  let stopping = false;

  function peerInfo(peer) { return { id: peer.id, name: peer.name, role: peer.role }; }
  function roomInfo() { return { id: roomId, name: roomName, maxParticipants: MAX_PARTICIPANTS }; }
  function error(ws, message) { send(ws, { type: 'error', message }); }
  function broadcast(payload, exceptId) {
    for (const peer of accepted.values()) if (peer.id !== exceptId) send(peer.ws, payload);
  }
  function welcome(peer) {
    send(peer.ws, { type: 'welcome', selfId: peer.id, hostId, room: roomInfo(),
      peers: [...accepted.values()].filter(p => p.id !== peer.id).map(peerInfo) });
  }
  function closeWith(ws, message, type = 'error', code = 1008) {
    send(ws, type === 'error' ? { type, message } : { type, reason: message });
    ws.close(code, message.slice(0, 100));
  }
  function releaseControl(targetId, reason = 'Permission revoked.') {
    const grant = controllers.get(targetId);
    if (!grant) return;
    controllers.delete(targetId);
    send(accepted.get(grant.controllerId)?.ws || { readyState: -1 },
      { type: 'control-revoke', from: targetId, sessionId: grant.sessionId, reason });
    send(accepted.get(targetId)?.ws || { readyState: -1 },
      { type: 'control-revoked', peerId: grant.controllerId, sessionId: grant.sessionId, reason });
  }
  function issueControl(owner, controller, sessionId) {
    releaseControl(owner.id, 'Another controller was selected.');
    controllers.set(owner.id, { controllerId: controller.id, sessionId });
    send(controller.ws, { type: 'control-response', from: owner.id, accepted: true, sessionId });
    send(owner.ws, { type: 'control-granted', peerId: controller.id, targetId: owner.id, sessionId });
  }
  function removePeer(peer) {
    clearTimeout(peer.admissionTimer);
    const wasPending = pending.delete(peer.id);
    const wasAccepted = accepted.has(peer.id);
    // Keep the owner present long enough to deliver revocation notifications.
    if (wasAccepted) {
      releaseControl(peer.id, 'Screen owner disconnected.');
      for (const [targetId, grant] of controllers) {
        if (grant.controllerId === peer.id) releaseControl(targetId, 'Controller disconnected.');
      }
      accepted.delete(peer.id);
    }
    for (const [key, req] of controlRequests) {
      if (req.targetId === peer.id || req.controllerId === peer.id) controlRequests.delete(key);
    }
    if (wasPending && hostId) send(accepted.get(hostId)?.ws || { readyState: -1 }, { type: 'join-cancelled', peerId: peer.id });
    if (!wasAccepted) return;
    if (peer.id === hostId) {
      hostId = null;
      for (const other of [...accepted.values(), ...pending.values()]) {
        closeWith(other.ws, 'The room host disconnected.', 'room-ended', 1000);
      }
      accepted.clear(); pending.clear(); controlRequests.clear(); controllers.clear();
    } else {
      broadcast({ type: 'peer-left', peerId: peer.id, id: peer.id });
    }
  }

  async function handleHttp(req, res) {
    const headers = {
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' wss: https:; img-src 'self' data: blob:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      'Permissions-Policy': 'camera=(self), microphone=(self), display-capture=(self)',
    };
    if (tls) headers['Strict-Transport-Security'] = 'max-age=86400';
    function respond(code, body, type = 'text/plain; charset=utf-8') {
      res.writeHead(code, { ...headers, 'Content-Type': type }); res.end(body);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { respond(405, 'Method not allowed.'); return; }
    let pathname;
    try {
      const requestUrl = new URL(req.url, 'https://localhost');
      pathname = decodeURIComponent(requestUrl.pathname);
      if (requestUrl.search || pathname.includes('\0') || pathname.includes('\\')) { respond(400, 'Invalid path.'); return; }
    } catch { respond(400, 'Invalid path.'); return; }
    if (pathname === '/health') {
      respond(200, req.method === 'HEAD' ? '' : JSON.stringify({ status: hostId ? 'online' : 'waiting', participants: accepted.size }), 'application/json; charset=utf-8'); return;
    }
    if (!assetsRoot) { respond(404, 'Not found.'); return; }
    const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
    // Resolve both ordinary traversal and symlinks before reading any file.
    const resolved = path.resolve(assetsRoot, relative);
    if (!resolved.startsWith(`${assetsRoot}${path.sep}`)) { respond(403, 'Forbidden.'); return; }
    const ext = path.extname(resolved).toLowerCase();
    if (!Object.hasOwn(CONTENT_TYPES, ext)) { respond(404, 'Not found.'); return; }
    try {
      const actual = await fs.promises.realpath(resolved);
      if (!actual.startsWith(`${assetsRoot}${path.sep}`)) { respond(403, 'Forbidden.'); return; }
      const stat = await fs.promises.stat(actual);
      if (!stat.isFile()) { respond(404, 'Not found.'); return; }
      if (req.method === 'HEAD') { respond(200, '', CONTENT_TYPES[ext]); return; }
      const body = await fs.promises.readFile(actual);
      respond(200, body, CONTENT_TYPES[ext]);
    } catch { respond(404, 'Not found.'); }
  }

  const server = tls ? https.createServer({ ...tls, minVersion: 'TLSv1.2' }, handleHttp) : http.createServer(handleHttp);
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    let requestUrl;
    try { requestUrl = new URL(req.url, 'https://localhost'); } catch { socket.destroy(); return; }
    if (stopping || requestUrl.pathname !== '/ws' || requestUrl.search || sockets.size >= 16) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });
  wss.on('connection', (ws, req) => {
    sockets.add(ws);
    ws.on('error', () => { /* Never log signaling data or invitation secrets. */ });
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    let peer = null;
    let rateStart = Date.now(); let rateCount = 0;
    const joinTimer = setTimeout(() => closeWith(ws, 'Join timed out.'), JOIN_TIMEOUT_MS);
    joinTimer.unref();
    ws.on('close', () => {
      clearTimeout(joinTimer); sockets.delete(ws); if (peer) removePeer(peer);
    });
    ws.on('message', (raw, isBinary) => {
      if (Date.now() - rateStart > 5000) { rateStart = Date.now(); rateCount = 0; }
      if (++rateCount > 150) { closeWith(ws, 'Too many messages.'); return; }
      if (isBinary) { error(ws, 'Only JSON messages are supported.'); return; }
      let message;
      try { message = JSON.parse(raw.toString()); } catch { error(ws, 'Invalid JSON.'); return; }
      if (!message || Array.isArray(message) || typeof message !== 'object' || typeof message.type !== 'string') {
        error(ws, 'Invalid message.'); return;
      }
      if (!peer) {
        if (message.type !== 'join') { error(ws, 'Join the room first.'); return; }
        if (!secretMatches(message.roomKey, roomKey)) { closeWith(ws, 'Invalid invitation or room unavailable.'); return; }
        const name = cleanName(message.name);
        if (!name) { closeWith(ws, 'A display name is required.'); return; }
        const wantsHost = Object.hasOwn(message, 'hostToken');
        if (wantsHost && (!isLoopback(req.socket.remoteAddress) || !secretMatches(message.hostToken, hostToken))) {
          closeWith(ws, 'Invalid invitation or room unavailable.'); return;
        }
        if (wantsHost && hostId) { closeWith(ws, 'The room already has a host.'); return; }
        if (!wantsHost && !hostId) { closeWith(ws, 'The room is waiting for its host.'); return; }
        if (!wantsHost && (accepted.size >= MAX_PARTICIPANTS || pending.size >= MAX_PENDING)) {
          closeWith(ws, 'The room is full.'); return;
        }
        clearTimeout(joinTimer);
        peer = { id: crypto.randomUUID(), name, role: wantsHost ? 'host' : 'guest', ws, admissionTimer: null };
        if (wantsHost) {
          hostId = peer.id; accepted.set(peer.id, peer); welcome(peer);
        } else {
          pending.set(peer.id, peer);
          send(ws, { type: 'pending', selfId: peer.id, room: roomInfo(), message: 'Waiting for the host to approve.' });
          send(accepted.get(hostId).ws, { type: 'join-request', peerId: peer.id, name: peer.name });
          peer.admissionTimer = setTimeout(() => {
            if (!pending.delete(peer.id)) return;
            if (hostId) send(accepted.get(hostId)?.ws || { readyState: -1 },
              { type: 'join-cancelled', peerId: peer.id, reason: 'The connection request expired.' });
            closeWith(ws, 'The connection request expired. Ask to join again.', 'rejected');
          }, admissionTimeoutMs);
          peer.admissionTimer.unref();
        }
        return;
      }
      if (!accepted.has(peer.id)) { error(ws, 'Host approval is required.'); return; }
      if (message.type === 'approve' || message.type === 'reject' || message.type === 'kick') {
        if (peer.id !== hostId) { error(ws, 'Only the host can manage room admission.'); return; }
        if (typeof message.peerId !== 'string') { error(ws, 'A participant is required.'); return; }
        const target = message.type === 'kick' ? accepted.get(message.peerId) : pending.get(message.peerId);
        if (!target || target.id === hostId) { error(ws, 'Participant not found.'); return; }
        if (message.type === 'approve') {
          if (accepted.size >= MAX_PARTICIPANTS) { error(ws, 'The room is full.'); return; }
          clearTimeout(target.admissionTimer);
          pending.delete(target.id); accepted.set(target.id, target); welcome(target);
          broadcast({ type: 'peer-joined', peer: peerInfo(target) }, target.id);
          send(ws, { type: 'join-approved', peerId: target.id });
        } else {
          clearTimeout(target.admissionTimer);
          if (message.type === 'reject') pending.delete(target.id);
          else removePeer(target);
          closeWith(target.ws, message.type === 'reject' ? 'The host declined the request.' : 'The host ended your participation.', 'rejected');
          send(ws, { type: message.type === 'reject' ? 'join-rejected' : 'peer-kicked', peerId: target.id });
        }
        return;
      }
      if (message.type === 'leave') { ws.close(1000, 'Left room.'); return; }
      if (message.type === 'ping') { send(ws, { type: 'pong', time: Date.now() }); return; }
      if (message.type === 'signal') {
        const target = accepted.get(message.to);
        if (!target || target.id === peer.id) { error(ws, 'Approved recipient not found.'); return; }
        if (!message.data || Array.isArray(message.data) || typeof message.data !== 'object' ||
            Buffer.byteLength(JSON.stringify(message.data)) > MAX_MESSAGE_BYTES) { error(ws, 'Invalid signaling data.'); return; }
        send(target.ws, { type: 'signal', from: peer.id, data: message.data }); return;
      }
      if (message.type === 'control-request') {
        const target = accepted.get(message.to);
        if (!target || target.id === peer.id) { error(ws, 'Approved screen owner not found.'); return; }
        const requestId = crypto.randomUUID();
        controlRequests.set(`${target.id}:${peer.id}`, { targetId: target.id, controllerId: peer.id, requestId, createdAt: Date.now() });
        send(target.ws, { type: 'control-request', from: peer.id, name: peer.name, requestId });
        send(ws, { type: 'control-pending', to: target.id, requestId }); return;
      }
      if (message.type === 'control-response') {
        const target = accepted.get(message.to);
        const key = `${peer.id}:${message.to}`; const request = controlRequests.get(key);
        if (!target || !request || Date.now() - request.createdAt > 60000 ||
            (message.requestId && message.requestId !== request.requestId)) { error(ws, 'Control request not found or expired.'); return; }
        if (typeof message.accepted !== 'boolean' || (message.accepted &&
          (typeof message.sessionId !== 'string' || message.sessionId.length < 16 || message.sessionId.length > 128))) {
          error(ws, 'A valid owner-issued control session is required.'); return;
        }
        controlRequests.delete(key);
        if (message.accepted) issueControl(peer, target, message.sessionId);
        else send(target.ws, { type: 'control-response', from: peer.id, accepted: false });
        return;
      }
      if (message.type === 'grant-control') {
        const target = accepted.get(message.peerId);
        if (!target || target.id === peer.id || message.targetId !== peer.id) { error(ws, 'Only the screen owner can grant control.'); return; }
        if (typeof message.sessionId !== 'string' || message.sessionId.length < 16 || message.sessionId.length > 128) {
          error(ws, 'A valid owner-issued control session is required.'); return;
        }
        controlRequests.delete(`${peer.id}:${target.id}`); issueControl(peer, target, message.sessionId); return;
      }
      if (message.type === 'control-revoke' || message.type === 'revoke-control') {
        const grant = controllers.get(peer.id);
        if (!grant || (message.to && message.to !== grant.controllerId)) { error(ws, 'Control grant not found.'); return; }
        releaseControl(peer.id); return;
      }
      error(ws, 'Unsupported message type.');
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of sockets) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false; if (ws.readyState === WebSocket.OPEN) ws.ping();
    }
    const now = Date.now();
    for (const [key, request] of controlRequests) if (now - request.createdAt > 60000) controlRequests.delete(key);
  }, 15000);
  heartbeat.unref();
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => { server.removeListener('error', reject); resolve(); });
    });
  } catch (err) { clearInterval(heartbeat); wss.close(); throw err; }
  const actualPort = server.address().port;
  const displayHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host.includes(':') ? `[${host}]` : host;
  let stopPromise = null;
  function stop() {
    if (stopPromise) return stopPromise;
    stopping = true; clearInterval(heartbeat);
    stopPromise = new Promise(resolve => {
      for (const ws of sockets) { send(ws, { type: 'room-ended', reason: 'The host closed the room.' }); ws.terminate(); }
      wss.close(() => server.close(() => resolve()));
      server.closeIdleConnections?.();
    });
    return stopPromise;
  }
  return { server, port: actualPort, url: `${tls ? 'https' : 'http'}://${displayHost}:${actualPort}`,
    roomKey, roomId, hostToken, stop,
    isAcceptedPeer: id => typeof id === 'string' && accepted.has(id) };
}

module.exports = { createBroker, MAX_PARTICIPANTS, MAX_MESSAGE_BYTES };
