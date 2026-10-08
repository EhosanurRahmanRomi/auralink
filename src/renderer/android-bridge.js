/* Optional native Android adapter. Desktop and ordinary browsers use no bridge. */
(() => {
  'use strict';
  const native = window.AuralinkNative;
  if (!native || typeof native.postMessage !== 'function' || window.auralink) return;

  const requests = new Map();
  const sockets = new Map();
  const stopListeners = new Set();
  const frameListeners = new Set();
  const screenStopListeners = new Set();
  const emergencyListeners = new Set();
  const mediaErrorListeners = new Set();
  const invitationListeners = new Set();
  let screenSequence = -1;
  let screenCaptureId = null;
  let captureRequestNumber = 0;
  let requestNumber = 0;
  let socketNumber = 0;
  let stopped = false;

  function invoke(method, args = null) {
    return new Promise((resolve, reject) => {
      const requestId = `r${++requestNumber}`;
      const timeout = ['startScreenShare', 'grantControl'].includes(method) ? 120000 : ['trustInvite', 'trustInternetService'].includes(method) ? 60000 : 15000;
      const timer = setTimeout(() => { requests.delete(requestId); reject(new Error('The Android service did not respond.')); }, timeout);
      requests.set(requestId, { resolve, reject, timer });
      try { native.postMessage(JSON.stringify({ requestId, method, args })); }
      catch (error) { clearTimeout(timer); requests.delete(requestId); reject(error); }
    });
  }

  function dispatch(socket, type, fields = {}) {
    const event = type === 'message' ? new MessageEvent('message', { data: String(fields.data || '') }) : new Event(type);
    for (const [key, value] of Object.entries(fields)) {
      if (key !== 'data') Object.defineProperty(event, key, { value });
    }
    socket.dispatchEvent(event);
  }

  function relayPacketSizeAllowed(raw, direction = 'outgoing') {
    if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > 262144) return false;
    let packet; try { packet = JSON.parse(raw); } catch { return false; }
    const field = direction === 'incoming' ? 'from' : 'to';
    const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
    if (!exact(packet, ['type', field, 'data']) || packet.type !== 'signal' || typeof packet[field] !== 'string' || !packet[field] || packet[field].length > 128 || !exact(packet.data, ['relay'])) return false;
    const relay = packet.data.relay;
    if (!exact(relay, ['version', 'epoch', 'counter', 'nonce', 'ciphertext']) || relay.version !== 1 || !Number.isSafeInteger(relay.counter) || relay.counter < 1 || !/^[A-Za-z0-9_-]{16}$/.test(relay.epoch) || !/^[A-Za-z0-9_-]{16}$/.test(relay.nonce) || typeof relay.ciphertext !== 'string' || !/^[A-Za-z0-9_-]+$/.test(relay.ciphertext) || relay.ciphertext.length > 240000) return false;
    try { const size = atob(relay.ciphertext.replaceAll('-', '+').replaceAll('_', '/')).length; return size >= 16 && size <= 180000; } catch { return false; }
  }

  class NativeSocket extends EventTarget {
    constructor(url) {
      super();
      const parsed = new URL(url);
      if (parsed.protocol !== 'wss:' || !['/ws', '/internet/ws'].includes(parsed.pathname) || parsed.search || parsed.hash || parsed.username || parsed.password) throw new Error('Use a pinned HTTPS room invitation or a verified Internet service.');
      this.url = parsed.href;
      this.id = `socket-${++socketNumber}`;
      this._state = 0;
      this._closeTimer = null;
      sockets.set(this.id, this);
      // Queue construction so callers can attach the same listeners they use
      // for browser WebSocket before the native connection returns an event.
      queueMicrotask(() => {
        if (this._state !== 0) return;
        if (stopped) { this.fail('The Android session has stopped.'); return; }
        invoke('openSocket', { socketId: this.id, url: this.url }).catch((error) => { if (this._state < 2) this.fail(error.message); });
      });
    }

    get readyState() { return this._state; }
    get bufferedAmount() { return 0; }

    send(data) {
      if (this._state !== 1) throw new DOMException('The connection is not open.', 'InvalidStateError');
      if (typeof data !== 'string' || (new TextEncoder().encode(data).length > 65536 && (!this.url.endsWith('/internet/ws') || !relayPacketSizeAllowed(data)))) throw new TypeError('Signaling accepts JSON text up to 64 KB, or a bounded encrypted Internet relay packet.');
      invoke('sendSocket', { socketId: this.id, data }).catch((error) => { if (this._state < 2) this.fail(error.message); });
    }

    close() {
      if (this._state >= 2) return;
      this._state = 2;
      invoke('closeSocket', { socketId: this.id }).catch(() => {});
      this._closeTimer = setTimeout(() => this.finish(1000, 'Closed locally.'), 1000);
    }

    fail(message) {
      if (this._state >= 2) return;
      dispatch(this, 'error', { message: String(message || 'The pinned room connection failed.') });
      this._state = 2;
      invoke('closeSocket', { socketId: this.id }).catch(() => {});
      this.finish(1006, String(message || 'Connection failed.'));
    }

    finish(code = 1000, reason = '') {
      if (this._state === 3) return;
      this._state = 3;
      clearTimeout(this._closeTimer);
      sockets.delete(this.id);
      dispatch(this, 'close', { code: Number(code) || 1000, reason: String(reason).slice(0, 200), wasClean: Number(code) === 1000 });
    }

    nativeEvent(message) {
      if (message.type === 'open') {
        if (this._state !== 0) { invoke('closeSocket', { socketId: this.id }).catch(() => {}); return; }
        this._state = 1; dispatch(this, 'open');
      } else if (message.type === 'message' && this._state === 1) {
        if (typeof message.data === 'string' && (new TextEncoder().encode(message.data).length <= 65536 || this.url.endsWith('/internet/ws') && relayPacketSizeAllowed(message.data, 'incoming'))) dispatch(this, 'message', { data: message.data });
      } else if (message.type === 'close') this.finish(message.code, message.reason);
      else if (message.type === 'error') this.fail(message.message);
    }
  }

  function receive(payload) {
    let message;
    try { message = typeof payload === 'string' ? JSON.parse(payload) : payload; } catch { return; }
    if (!message || typeof message !== 'object' || Array.isArray(message)) return;
    if (message.event === 'socket') {
      sockets.get(message.socketId)?.nativeEvent(message); return;
    }
    if (message.event === 'app-invitation') {
      if (typeof message.code !== 'string' || message.code.length > 128 || !/^A1\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/i.test(message.code)) return;
      for (const listener of invitationListeners) { try { listener(message.code); } catch { /* Invitations never change native consent. */ } }
      return;
    }
    if (message.event === 'control-stop' || message.event === 'media-error') {
      const listeners = message.event === 'control-stop' ? emergencyListeners : mediaErrorListeners;
      for (const listener of listeners) { try { listener(String(message.reason || 'Android permission ended.')); } catch { /* Native state remains authoritative. */ } }
      return;
    }
    if (message.event === 'screen') {
      // Events already queued for an old projection cannot reset the replay
      // counter or end a later owner-approved projection.
      if (screenCaptureId !== null && message.captureId !== screenCaptureId) return;
      if (message.type === 'frame') {
        if (stopped || !Number.isSafeInteger(message.seq) || message.seq <= screenSequence ||
            !Number.isInteger(message.width) || !Number.isInteger(message.height) ||
            message.width < 1 || message.height < 1 || Math.max(message.width, message.height) > 1920 ||
            typeof message.data !== 'string' || message.data.length > 4000000 ||
            !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(message.data)) return;
        screenSequence = message.seq;
        for (const listener of frameListeners) { try { listener(message); } catch { /* Frame consumers have separate lifetimes. */ } }
      } else if (message.type === 'stopped') {
        screenSequence = -1;
        screenCaptureId = null;
        const capture = { captureId: typeof message.captureId === 'string' ? message.captureId : null };
        for (const listener of screenStopListeners) { try { listener(String(message.reason || 'Phone screen sharing stopped.'), capture); } catch { /* Native consent stays authoritative. */ } }
      }
      return;
    }
    if (message.event === 'session-stop') {
      stopped = true;
      screenSequence = -1;
      screenCaptureId = null;
      captureRequestNumber++;
      for (const socket of [...sockets.values()]) { socket.close(); socket.finish(1000, String(message.reason || 'The Android call ended.')); }
      for (const request of requests.values()) { clearTimeout(request.timer); request.reject(new Error('Android session stopped.')); }
      requests.clear();
      for (const listener of stopListeners) { try { listener(message.reason); } catch { /* A UI listener cannot reopen the native session. */ } }
      return;
    }
    if (message.event === 'session-resume') { stopped = false; return; }
    const request = requests.get(message.requestId);
    if (!request) return;
    clearTimeout(request.timer); requests.delete(message.requestId);
    if (message.ok === true) request.resolve(message.result);
    else request.reject(new Error(String(message.error || 'The Android service declined this action.').slice(0, 240)));
  }

  Object.defineProperty(window, '__auralinkNativeReceive', { value: receive, writable: false, configurable: false });
  Object.defineProperty(window, 'auralink', {
    value: Object.freeze({
      platform: 'android',
      getInfo: () => invoke('getInfo'),
      getPendingInvitation: () => invoke('getPendingInvitation'),
      trustInvite: (invite) => {
        if (typeof invite !== 'string' || invite.length > 4096) return Promise.reject(new TypeError('Invalid room invitation.'));
        stopped = false;
        return invoke('trustInvite', invite);
      },
      trustInternetService: (serviceURL) => {
        try {
          if (typeof serviceURL !== 'string' || serviceURL.length > 2048 || /[^\x20-\x7e]/.test(serviceURL)) throw new TypeError('Invalid Internet service address.');
          if (!/^https:\/\/(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(?::[0-9]+)?\/?$/i.test(serviceURL.trim()))
            throw new TypeError('Use the Internet service HTTPS root address without credentials, query or fragment.');
          const service = new URL(serviceURL.trim());
          if (service.protocol !== 'https:' || !['', '/'].includes(service.pathname) || service.username || service.password || service.search || service.hash || /[?#]/.test(serviceURL))
            throw new TypeError('Use the Internet service HTTPS root address without credentials, query or fragment.');
          stopped = false;
          return invoke('trustInternetService', service.origin);
        } catch (error) { return Promise.reject(error); }
      },
      copyText: (text) => typeof text === 'string' && text.length <= 4096 ? invoke('copyText', text) : Promise.reject(new TypeError('Invalid clipboard text.')),
      createSocket: (url) => new NativeSocket(url),
      createInternetSocket: (url) => {
        if (new URL(url).pathname !== '/internet/ws') throw new TypeError('Use the verified Internet service socket.');
        return new NativeSocket(url);
      },
      startScreenShare: (args) => {
        const captureRequest = ++captureRequestNumber;
        return invoke('startScreenShare', args).then((screen) => {
          if (captureRequest === captureRequestNumber && !stopped) {
            screenSequence = -1;
            screenCaptureId = typeof screen?.captureId === 'string' ? screen.captureId : null;
          }
          return screen;
        });
      },
      stopScreenShare: (args) => invoke('stopScreenShare', args),
      stopSharing: (args) => invoke('stopScreenShare', args),
      ackScreenFrame: (args) => invoke('ackScreenFrame', args),
      grantControl: (args) => invoke('grantControl', args),
      revokeControl: () => invoke('revokeControl'),
      applyInput: (args) => invoke('applyInput', args),
      inputStatus: () => invoke('inputStatus'),
      setAudioRoute: (args) => invoke('setAudioRoute', args).then((result) => {
        if (result?.ok === false) throw new Error(String(result.reason || 'Android could not activate call audio.').slice(0, 240));
        return result;
      }),
      onScreenFrame: (listener) => {
        if (typeof listener !== 'function') return () => {};
        frameListeners.add(listener); return () => frameListeners.delete(listener);
      },
      onScreenStopped: (listener) => {
        if (typeof listener !== 'function') return () => {};
        screenStopListeners.add(listener); return () => screenStopListeners.delete(listener);
      },
      onEmergencyStop: (listener) => {
        if (typeof listener !== 'function') return () => {};
        emergencyListeners.add(listener); return () => emergencyListeners.delete(listener);
      },
      onMediaError: (listener) => {
        if (typeof listener !== 'function') return () => {};
        mediaErrorListeners.add(listener); return () => mediaErrorListeners.delete(listener);
      },
      onInvitation: (listener) => {
        if (typeof listener !== 'function') return () => {};
        invitationListeners.add(listener); return () => invitationListeners.delete(listener);
      },
      onSessionStop: (listener) => {
        if (typeof listener !== 'function') return () => {};
        stopListeners.add(listener); return () => stopListeners.delete(listener);
      },
    }),
    writable: false, configurable: false,
  });
})();
