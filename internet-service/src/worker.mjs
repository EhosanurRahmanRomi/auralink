import { Coordinator, LIMITS } from './coordinator.mjs';

const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.search || url.username || url.password) return new Response('{"error":"Invalid address"}', { status: 400, headers });
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
  }
  loadDevices() { return [...this.sql.exec('SELECT record FROM devices LIMIT 32')].map(row => JSON.parse(row.record)); }
  saveDevice(device) { this.sql.exec('INSERT OR REPLACE INTO devices (id, record) VALUES (?, ?)', device.id, JSON.stringify(device)); }
  deleteDevice(id) { this.sql.exec('DELETE FROM devices WHERE id = ?', id); }
  loadRooms() { return [...this.sql.exec('SELECT record FROM rooms LIMIT 32')].map(row => JSON.parse(row.record)); }
  saveRoom(room) { this.sql.exec('INSERT OR REPLACE INTO rooms (id, record) VALUES (?, ?)', room.id, JSON.stringify(room)); }
  deleteRoom(id) { this.sql.exec('DELETE FROM rooms WHERE id = ?', id); }
  loadBudget() { return JSON.parse([...this.sql.exec('SELECT record FROM budget WHERE id = 1')][0]?.record || '{"daily":0,"monthly":0}'); }
  saveBudget(budget) { this.sql.exec('INSERT OR REPLACE INTO budget (id, record) VALUES (1, ?)', JSON.stringify(budget)); }
}
function transport(ws) {
  return { send: payload => ws.send(JSON.stringify(payload)), close: (code, reason) => ws.close(code, reason),
    save: attachment => ws.serializeAttachment(attachment) };
}
export class AuralinkCoordinator {
  constructor(ctx, env) {
    this.ctx = ctx;
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
    const pair = new WebSocketPair(); const client = pair[0], server = pair[1];
    this.ctx.acceptWebSocket(server);
    this.engine.attach(transport(server)); await this.schedule();
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
