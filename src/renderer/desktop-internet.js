/* Native desktop transport keeps certificate and room authorization outside the renderer. */
let nextSocket = 0;
export function createDesktopInternetSocket(bridge, url) {
  return new DesktopInternetSocket(bridge, url);
}
class DesktopInternetSocket extends EventTarget {
  constructor(bridge, url) {
    super();
    const parsed = new URL(url);
    if (parsed.protocol !== 'wss:' || parsed.pathname !== '/internet/ws' || parsed.search || parsed.hash || parsed.username || parsed.password) throw new Error('Invalid internet socket address.');
    this.bridge = bridge; this.url = parsed.href; this.id = `internet-${++nextSocket}`;
    this.readyState = 0; this.bufferedAmount = 0;
    this.unsubscribe = bridge.onInternetEvent(message => {
      if (message?.socketId !== this.id || this.readyState === 3) return;
      if (message.type === 'open') {
        if (this.readyState !== 0) return;
        this.readyState = 1; this.dispatchEvent(new Event('open'));
      } else if (message.type === 'message' && this.readyState === 1) {
        this.dispatchEvent(new MessageEvent('message', { data: String(message.data) }));
      } else if (message.type === 'error') this.dispatchEvent(new Event('error'));
      else if (message.type === 'close') this.finish(message.code, message.reason);
    });
    queueMicrotask(() => {
      if (this.readyState !== 0) return;
      bridge.internetOpen({ socketId: this.id, url: this.url }).catch(() => {
        if (this.readyState === 3) return;
        this.dispatchEvent(new Event('error')); this.finish(1006, 'The verified internet connection failed.');
      });
    });
  }
  send(data) {
    if (this.readyState !== 1) throw new DOMException('The internet connection is not open.', 'InvalidStateError');
    if (typeof data !== 'string' || new TextEncoder().encode(data).length > 65536) throw new TypeError('Internet signaling accepts text up to 64 KB.');
    this.bridge.internetSend({ socketId: this.id, data }).catch(() => {
      if (this.readyState === 3) return;
      this.dispatchEvent(new Event('error')); this.close();
    });
  }
  close() {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    this.bridge.internetClose({ socketId: this.id }).catch(() => {});
    this.closeTimer = setTimeout(() => this.finish(1000, 'Closed locally.'), 1500);
  }
  finish(code = 1000, reason = '') {
    if (this.readyState === 3) return;
    this.readyState = 3; clearTimeout(this.closeTimer); this.unsubscribe?.();
    const event = new Event('close');
    Object.defineProperties(event, { code: { value: code }, reason: { value: String(reason || '') }, wasClean: { value: code === 1000 } });
    this.dispatchEvent(event);
  }
}
