import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { fileURLToPath } from 'node:url';

// Used only by local runtime/browser tests; no real account or provider credentials.
export async function createLocalCoordinator(options = {}) {
  const pairingKey = options.pairingKey || 'test-only-private-pairing-key-abcdefghijklmnopqrstuvwxyz';
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: ['worker.mjs', 'coordinator.mjs'].map(name => ({ type: 'ESModule', path: fileURLToPath(new URL(`../src/${name}`, import.meta.url)) })),
    compatibilityDate: '2026-10-07', host: '127.0.0.1', port: options.port || 0,
    durableObjects: { COORDINATOR: { className: 'AuralinkCoordinator', useSQLite: true } },
    bindings: { PAIRING_KEY: pairingKey, RELAY_ENABLED: 'false', ...options.bindings },
    ...(options.outbound ? { outboundService: options.outbound } : {}),
    ...(options.persist ? { durableObjectsPersist: options.persist } : {}) }));
  const url = (await mf.ready).toString().replace(/\/$/, '');
  return { mf, url, pairingKey, close: () => mf.dispose() };
}
