import { Coordinator, LIMITS, sourceHash, canonicalBase64url } from './coordinator.mjs';

const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
export function invitationCode(fragment) {
  if (typeof fragment !== 'string' || fragment.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(fragment)) return null;
  const fields = new URLSearchParams(fragment.startsWith('#') ? fragment.slice(1) : fragment);
  if ([...fields.keys()].sort().join(',') !== 'internet,key,room' || fields.get('internet') !== '1') return null;
  const room = fields.get('room'), key = fields.get('key');
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(room || '') ||
      !canonicalBase64url(key, 32, 32)) return null;
  return 'A1.' + room + '.' + key;
}
function invitationLanding() {
  const nonce = crypto.randomUUID().replaceAll('-', '');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Glance-Port invitation</title>
<style nonce="${nonce}">:root{color-scheme:dark;font-family:system-ui,sans-serif}*{box-sizing:border-box}body{margin:0;min-height:100svh;display:grid;place-items:center;padding:24px;background:radial-gradient(ellipse at 20% 0%,#683750,transparent 60%),radial-gradient(ellipse at 90% 80%,#7a452f,transparent 55%),#1b111b;color:#fff6f2}main{width:min(620px,100%);padding:36px;border:1px solid #e7b4c540;border-radius:26px;background:#301b2ddb;box-shadow:0 30px 90px #0005}.brand{letter-spacing:.14em;color:#ffcda8;font-size:13px;font-weight:700}h1{font-size:clamp(28px,6vw,42px);letter-spacing:-.04em;line-height:1.1;margin:18px 0}p{color:#ead3de;line-height:1.65}code{display:block;overflow-wrap:anywhere;padding:18px;background:#1e141e;border-radius:12px;border:1px solid #765369;margin:22px 0;font-size:15px;user-select:all}.actions{display:flex;gap:12px;flex-wrap:wrap}a,button{font:inherit;border-radius:10px;padding:13px 18px;border:1px solid #93687a;cursor:pointer;text-decoration:none;color:#fff6f2;background:#563346}.primary{background:linear-gradient(120deg,#d58a80,#bd85b1);border:0}.disabled{opacity:.5;pointer-events:none}footer{margin-top:26px;color:#c8a8b9;font-size:13px}footer a{border:0;padding:0;background:none;color:#ffd5a8}#status{min-height:26px}</style></head>
<body><main><div class="brand">GLANCE-PORT · CONNECT TOGETHER</div><h1 id="title">Your room invitation</h1><p id="description">Open this invitation in the Glance-Port app on Windows, macOS or Android. The host must keep the room open. Screen control always needs a separate permission.</p><code id="code">No invitation code in this address.</code><div class="actions"><a id="open" class="primary disabled" aria-disabled="true">Open Glance-Port</a><button id="copy" disabled>Copy code</button></div><p id="status" role="status"></p><footer>Need the app? <a href="https://github.com/EhosanurRahmanRomi/glance-port/releases/latest" rel="noreferrer noopener" target="_blank">Download Windows, macOS or Android</a><p>An expired invitation, locked room or offline host requires a new invitation from the host. This page does not join a call or access your microphone.</p></footer></main>
<script nonce="${nonce}">'use strict';${canonicalBase64url.toString()};${invitationCode.toString()};(() => { const invitation=invitationCode(location.hash);const code=document.getElementById('code'),open=document.getElementById('open'),copy=document.getElementById('copy'),status=document.getElementById('status');if(!invitation){document.getElementById('title').textContent='Connect with Glance-Port';document.getElementById('description').textContent='Ask your host for a Glance-Port invitation link or code, then open it in the app.';return;}code.textContent=invitation;open.href='auralink://join#code='+encodeURIComponent(invitation);open.classList.remove('disabled');open.removeAttribute('aria-disabled');copy.disabled=false;copy.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(invitation);status.textContent='Invitation code copied. Paste it into Join a room in Glance-Port.';}catch{const selection=getSelection(),range=document.createRange();range.selectNodeContents(code);selection.removeAllRanges();selection.addRange(range);status.textContent='Select and copy the code above, then paste it into Glance-Port.';}});open.addEventListener('click',()=>{status.textContent='If Glance-Port does not open, install it or copy the invitation code.';});})();</script></body></html>`;
  return new Response(html, { headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; connect-src 'none'`,
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()', 'Cross-Origin-Opener-Policy': 'same-origin' } });
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.search || url.username || url.password) return new Response('{"error":"Invalid address"}', { status: 400, headers });
    if (request.method === 'GET' && url.pathname === '/') return invitationLanding();
    if (request.method === 'GET' && url.pathname === '/internet/health') {
      return new Response(JSON.stringify({ service: 'auralink-internet', protocol: 1, status: 'ok' }), { headers });
    }
    if (request.method !== 'GET' || url.pathname !== '/internet/ws') return new Response('{"error":"Not found"}', { status: 404, headers });
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('{"error":"WebSocket required"}', { status: 426, headers });
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(env.PAIRING_KEY || '')) return new Response('{"error":"Coordinator not configured"}', { status: 503, headers });
    // A single small private beta has one shared directory. There is no public listing.
    const id = env.COORDINATOR.idFromName('private-beta-v1');
    return env.COORDINATOR.get(id).fetch(request);
  }
};

class SqlStore {
  constructor(sql) {
    this.sql = sql;
    sql.exec('CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, record TEXT NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, record TEXT NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS budget (id INTEGER PRIMARY KEY CHECK (id = 1), record TEXT NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS public_budget (id INTEGER PRIMARY KEY CHECK (id = 1), record TEXT NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS media_budget (id INTEGER PRIMARY KEY CHECK (id = 1), record TEXT NOT NULL)');
  }
  loadDevices() { return [...this.sql.exec('SELECT record FROM devices LIMIT 32')].map(row => JSON.parse(row.record)); }
  saveDevice(device) { this.sql.exec('INSERT INTO devices (id, record) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET record=excluded.record', device.id, JSON.stringify(device)); }
  deleteDevice(id) { this.sql.exec('DELETE FROM devices WHERE id = ?', id); }
  loadRooms() { return [...this.sql.exec('SELECT record FROM rooms LIMIT 48')].map(row => JSON.parse(row.record)); }
  saveRoom(room) { this.sql.exec('INSERT INTO rooms (id, record) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET record=excluded.record', room.id, JSON.stringify(room)); }
  deleteRoom(id) { this.sql.exec('DELETE FROM rooms WHERE id = ?', id); }
  loadBudget() { return JSON.parse([...this.sql.exec('SELECT record FROM budget WHERE id = 1')][0]?.record || '{"daily":0,"monthly":0}'); }
  saveBudget(budget) { this.sql.exec('INSERT OR REPLACE INTO budget (id, record) VALUES (1, ?)', JSON.stringify(budget)); }
  loadPublicBudget() { return JSON.parse([...this.sql.exec('SELECT record FROM public_budget WHERE id = 1')][0]?.record || '{"day":"","bootstrap":0,"create":0,"sources":{}}'); }
  savePublicBudget(budget) { this.sql.exec('INSERT INTO public_budget (id, record) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET record=excluded.record', JSON.stringify(budget)); }
  loadMediaBudget() { return JSON.parse([...this.sql.exec('SELECT record FROM media_budget WHERE id = 1')][0]?.record || '{"day":"","bytes":0,"messages":0,"rooms":{}}'); }
  saveMediaBudget(budget) { this.sql.exec('INSERT INTO media_budget (id, record) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET record=excluded.record', JSON.stringify(budget)); }
}
function transport(ws) {
  return { send: payload => ws.send(JSON.stringify(payload)), close: (code, reason) => ws.close(code, reason),
    save: attachment => ws.serializeAttachment(attachment) };
}
export class AuralinkCoordinator {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env;
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'));
    this.engine = new Coordinator({ store: new SqlStore(ctx.storage.sql), env,
      restored: ctx.getWebSockets().map(ws => {
        const attachment = ws.deserializeAttachment();
        const timestamp = ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime();
        if (attachment && Number.isFinite(timestamp)) attachment.lastSeen = Math.max(attachment.lastSeen, timestamp);
        return { transport: transport(ws), attachment };
      }) });
  }
  async schedule() {
    const deadline = this.engine.nextDeadline();
    if (Number.isFinite(deadline)) {
      const target = Math.max(Date.now() + 1000, deadline);
      const current = await this.ctx.storage.getAlarm();
      if (current === null || current > target || current <= Date.now()) await this.ctx.storage.setAlarm(target);
    } else await this.ctx.storage.deleteAlarm();
  }
  async fetch(request) {
    if (this.ctx.getWebSockets().length >= LIMITS.sockets) return new Response('Coordinator is busy.', { status: 503 });
    // Cloudflare supplies this header at the edge. Never persist or log the
    // source address; keyed hashes prevent offline IP enumeration from storage.
    const address = request.headers.get('CF-Connecting-IP') || 'local-runtime';
    const source = this.env.PUBLIC_ROOMS === 'true' ? await sourceHash(address.slice(0, 128), this.env.PAIRING_KEY) : null;
    const pair = new WebSocketPair(); const client = pair[0], server = pair[1];
    this.ctx.acceptWebSocket(server);
    this.engine.attach(transport(server), source); await this.schedule();
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(ws, message) {
    for (const socket of this.ctx.getWebSockets()) {
      this.engine.touch(socket.deserializeAttachment()?.connectionId, this.ctx.getWebSocketAutoResponseTimestamp(socket)?.getTime());
    }
    try { await this.engine.receive(ws.deserializeAttachment()?.connectionId, message); }
    catch {
      const id = ws.deserializeAttachment()?.connectionId;
      this.engine.disconnect(id); ws.close(1011, 'Coordinator unavailable. Reconnect.');
    }
    await this.schedule();
  }
  async webSocketClose(ws) { this.engine.disconnect(ws.deserializeAttachment()?.connectionId); await this.schedule(); }
  async webSocketError(ws) { this.engine.disconnect(ws.deserializeAttachment()?.connectionId); await this.schedule(); }
  async alarm() {
    for (const ws of this.ctx.getWebSockets()) {
      this.engine.touch(ws.deserializeAttachment()?.connectionId, this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime());
    }
    this.engine.reap(); await this.schedule();
  }
}
