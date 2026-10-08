# Glance-Port internet coordinator

Glance-Port 0.5.0 uses invitation rooms: the host opens a room, copies its code, and guests enter automatically with that code. No account, private pairing key or service-address entry is needed for the app's default public mode. Four people can join a room. Remote control still needs a separate permission from the actual screen owner. The earlier Auralink service identifiers, invitation protocol and deployed address stay compatible with the renamed app.

This Worker supplies signaling and bounded, client-encrypted media forwarding when direct WebRTC cannot connect through the participants' routers. It also retains the optional private paired-device directory from 0.3. Nearby rooms remain independent of this service. The service uses Cloudflare infrastructure; it is not fully decentralized or unlimited.

## Connection flow

1. An ephemeral public WebSocket authenticates with `bootstrap`. It receives a socket-bound identity, without a persistent account or device token. It cannot see the private device directory.
2. The host creates an invitation room and joins using a separate server-issued host capability. A guest with the high-entropy invitation enters automatically, up to the four-person limit. Public identities and rooms expire within one hour; reconnecting creates a new identity and requires joining again.
3. Direct encrypted WebRTC carries screen sharing, microphone audio and remote input when it can connect. STUN helps discover addresses but cannot bypass every restrictive network. The current desktop flow has no camera call.
4. If enabled, the client can forward encrypted compressed screen frames and mono PCM audio through the same verified WSS coordinator. Desktop WebCodecs uses H.264 or VP8 with an adaptive target up to 30 fps and a selectable resolution ceiling up to 1440p. Engines without a common codec use an explicitly labeled JPEG compatibility mode limited to 4 fps and a 1280-pixel long edge. This is an application fallback, not TURN. Actual quality depends on hardware, scene complexity, throughput and the free allowances below.
5. A host can kick a participant, disable the invitation, generate a new invitation, or block a connection. Blocking also disables the old invitation. An anonymous person with a new identity and a newly shared code can return; this is not a permanent account ban.
6. Screen control requires independent owner consent. A verified control lease lasts at most 15 minutes. Leaving, host disconnect, room change, socket replacement or revocation clears permission. Healthy hibernation preserves only the original, correctly bound unexpired lease.

An invitation is a capability: anyone who possesses it may enter the room. Share it only with intended participants and disable it after they join when appropriate. It does not authorize remote input. There is no public room listing or user search.

Invitation codes use `A1.<room UUID>.<43-character base64url key>`. Invitation links keep the room/key in the URL fragment, which is not sent to the HTTP server. The coordinator's root page parses the fragment locally and offers `auralink://join#code=…` plus a copy-code fallback. It does not join web calls, contact analytics, load external scripts or access a microphone. Custom private coordinators still use the app's Advanced setup rather than the default-service code shortcut.

## Free deployment

Use Node.js 22 or newer. From the project directory:

```powershell
cd internet-service
npm ci
npm test
npm run test:runtime
npm run check
npx wrangler login
```

OAuth login opens Cloudflare's official page; browser cookies are unnecessary. Stay on **Workers Free**. This configuration uses a SQLite Durable Object and a supplied `https://…workers.dev` address, so a purchased domain is unnecessary.

Generate a server secret and upload it through Wrangler's prompt:

```powershell
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))"
npx wrangler secret put PAIRING_KEY
```

Keep this secret out of GitHub, screenshots, invitations and installers. It protects private pairing, keyed source-rate identifiers and encrypted key caches. Normal public-room guests never enter it. For your own public invitation deployment, set `PUBLIC_ROOMS` to `"true"` in `wrangler.jsonc`. Enable `WEBSOCKET_RELAY` only after reviewing the limits below. Keep `RELAY_ENABLED` false to contact no TURN provider. Then run:

```powershell
npm run deploy
```

Wrangler prints the public origin. The default app uses the project's deployed coordinator; an alternate origin belongs in Advanced setup. Local development uses `.dev.vars` copied from `.dev.vars.example` and `npm run dev`. Local credentials, dependencies and runtime state are ignored by Git.

`GET /internet/health` returns HTTP 200 with:

```json
{"service":"auralink-internet","protocol":1,"status":"ok"}
```

WebSockets use `/internet/ws` without credentials or query strings. Internet TLS uses normal certificate-chain/hostname validation, separately from Nearby self-signed certificate pins.

## Finite free-beta limits

Cloudflare Free has finite quotas; exhausted operations fail rather than creating Free-plan overage charges. Account usage by other applications and hostile traffic can still make this beta unavailable earlier than its application limits. Remain on the Free plan: these guards do not create a spending cap for a paid account. See [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) and [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).

| Application guard | Limit |
| --- | --- |
| Public identities simultaneously / rooms simultaneously | 48 / 16 |
| All sockets / waiting unauthenticated sockets | 64 / 8 |
| Public room participants / identity and room lifetime | 4 / at most 1 hour |
| Public bootstraps / new rooms per UTC day | 1,024 / 256 |
| Source bootstraps per minute / per UTC day | 8 / 64 |
| Source new rooms per hour | 8 |
| Public normal commands per UTC day / per room per hour | 20,000 / 2,000 |
| Reserved encrypted media per UTC day, across all rooms | 300,000 packets and 1 GiB wire bytes |
| Reserved media per room | 512 MiB wire bytes and 30 minutes from its first packet |
| Forwarded media per sender | 600 packets and 6 MiB wire bytes per five-second window |
| Durable per-socket reservation ceiling | 2 MiB byte credits and 256 packet credits |
| Normal JSON / validated ciphertext signal wire size | 64 KiB / 256 KiB |

Each forwarded ciphertext packet counts separately, including video fragments and copies sent to different recipients. For the two-desktop test, two 3 Mbps screen feeds use approximately 8 Mbps of base64url wire traffic before audio and metadata; a 512 MiB room therefore supports roughly nine minutes at that rate. Two 4.5 Mbps feeds use about 12 Mbps wire traffic and consume that room allowance in roughly six minutes. Static screens and lower quality can use less. These are illustrative bandwidth calculations, not promised durations. The 30-minute timer is an upper bound; byte or packet exhaustion can occur earlier. Direct WebRTC does not consume these forwarding allowances.

Daily global counters reset at 00:00 UTC. A room's byte/time counters and a socket's burst counters survive hibernation and do not reset at midnight. Normal public commands and media use separate budgets. Heartbeats and local leave/forget cleanup do not consume the normal-command budget. Quota errors identify the exhausted allowance; direct WebRTC remains available after fallback exhaustion.

SQLite counters record **reserved allowances**, not exact bytes successfully delivered. Before forwarding, one atomic row UPSERT charges new byte and/or packet credits; the sender's latest durable WebSocket attachment stores the depleted residual bound to its day, room, peer and connection. Refills top up only the depleted dimension, so small audio/control packets do not reserve another full byte chunk. No packet performs a SQLite budget write while its lease has sufficient credits. Credits are never refunded: a crash between SQL and attachment persistence can waste allowance, while a healthy hibernation resumes the latest depleted attachment. Closing or changing rooms can waste at most 2 MiB and 256 packet credits per socket; midnight drops any unused old-day credits.

Independent refills make the 300,000-packet ceiling meaningful while keeping media budget reservations below roughly 1,800 SQLite UPSERTs per day at the configured byte, packet and room caps. Stable room updates use UPSERT rather than deleting/replacing indexed records. The separate 20,000 normal-command allowance leaves room for host invitation updates, bootstrap, room cleanup and alarm writes. These are conservative application guards, not an absolute account quota guarantee: private paired clients are trusted owner-controlled clients and have no daily public-command allowance; hostile connection attempts, alarms, index bookkeeping or unrelated account activity may exhaust free platform quotas earlier. Monitor the account during real-device tests before broad distribution.

## Encryption and permissions

Relay signals contain only `{version,epoch,counter,nonce,ciphertext}` inside `data.relay`. Ciphertext is base64url with 16–180,000 decoded bytes; epoch and nonce are exactly 12 bytes. The sender is derived from ready, admitted socket membership. Recipient checks, strict fields and rechecked membership after asynchronous key loading prevent pending, departed or cross-room forwarding. Large plaintext, arbitrary IPC messages and unapproved relay senders are refused by the Worker and native bridges.

Clients encrypt fallback payloads using AES-GCM and pair/epoch-specific keys derived from a room key; they enforce replay checks. The Worker forwards ciphertext and does not decode, record or log video/audio. It generates and distributes the room key over TLS, then stores only an AES-GCM-encrypted cache bound to the room and expiry. Because the coordinator distributes that key, this design is **not a zero-knowledge service**: a compromised key distributor could know the key. Hosting providers handle network metadata according to their policies.

Worker observability is disabled. SQLite stores capability/token hashes, encrypted temporary key/configuration caches, limited private device metadata, HMAC source identifiers and quota counters. No raw source IP is persisted or logged. Public bootstrap identities are ephemeral; private device tokens are hash-only persisted. Socket attachments contain bounded identity, admission, rate and consent state, never media or plaintext relay keys.

Clients send exact `{type:"ping"}` messages every 30 seconds. Cloudflare's [WebSocket hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) replies automatically; alarms refresh idle leases from those response timestamps. Unauthenticated sockets expire after ten seconds; idle sockets after two minutes. An interrupted welcome fails closed. Missing hosts end rooms; pending guests receive neither a media key nor signaling. Verified control leases bind owner/controller device, peer, socket and room IDs plus their original deadline.

## Advanced private group and optional TURN

Advanced pairing retains a private directory of at most 32 trusted devices. `pair` sends the owner's pairing key in a WSS frame; `register` uses the issued device token. Private guests require host admission even with an invitation or an online-device shortcut. `forget` deletes that registration and invalidates its token. Public clients never receive this directory, and public identities cannot join private rooms.

Optional TURN remains disabled. The published zero-cost configuration uses direct WebRTC and the bounded Workers Free WebSocket fallback, with no Metered provider requests and no Realtime subscription. On October 8, 2026, the inspected Cloudflare account's Realtime activation form required a payment method and explicitly billed usage above 1,000 GB. No payment information or subscription was submitted.

The source also includes a disabled Cloudflare TURN adapter. It requires `TURN_PROVIDER=cloudflare`, backend-only `CLOUDFLARE_TURN_KEY_ID` and `CLOUDFLARE_TURN_API_TOKEN`, and the explicit `CLOUDFLARE_TURN_FREE_ONLY_CONFIRMED=true` operator gate in addition to `RELAY_ENABLED=true`. **That gate is an assertion, not a spending cap.** Do not set it unless provider-enforced free-only account controls have actually been verified. The [free allowance](https://developers.cloudflare.com/realtime/sfu/platform/pricing/) and app issuance limits cannot guarantee no bill on a usage-based subscription. The adapter requests expiring credentials from the [official backend credential API](https://developers.cloudflare.com/realtime/turn/generate-credentials/), validates exact Cloudflare hosts, filters browser-blocked port 53, encrypts cached credentials and never returns its long-lived token to clients. This has mocked-provider coverage; no live Cloudflare TURN allocation is claimed.

Legacy Metered support requires an already-created, provider-expiring credential, a credential-scoped API key and verified free-account quota behavior. Set `METERED_APP_DOMAIN`, `METERED_API_KEY` and `METERED_CREDENTIAL_EXPIRES_AT` with Wrangler secrets only after verifying their availability and expiry on the actual plan. An app expiry setting cannot make static provider credentials expire. Do not enable paid billing or overages for this project.

The optional TURN guard allows four fetch attempts per UTC day, 60 per month, and ten minutes per room once TURN is offered. Failed fetches count. ICE caches are encrypted and reuse the original deadline through hibernation. The whole TURN-enabled room ends at its deadline, including when an individual selected route is direct. These issuance/session guards cannot guarantee provider byte usage or billing: copied credentials remain usable until their actual provider-enforced expiry. See [credential retrieval](https://www.metered.ca/docs/turn-rest-api/get-credential/) and [expiring credentials](https://www.metered.ca/docs/turnserver-guides/expiring-turn-credentials/).

## Protocol and verification

| Message | Result |
| --- | --- |
| `bootstrap` with `name` | Ephemeral `registered` with `mode:"public"`; no directory/token |
| `pair` / `register` | Private credentials/registration and private `presence` |
| `create-room`, then owner `join` with host capability | `room-created`, then admitted owner `welcome` |
| Guest `join` with invitation | Public automatic welcome; private pending/host approval |
| `approve`, `reject`, `kick` | Host-only private admission or participant removal |
| `burn-invite`, `rotate-invite`, `block` | Public host moderation; rotation key goes only to host |
| `signal` with `to`, `data` | Same-room ready-peer forwarding with server-derived `from` |
| `control-request` / `control-response` / `control-revoke` | Independent owner consent and revocation |
| `leave` / `forget` | Immediate room cleanup / own identity removal |

Welcome includes ICE before peer creation and, when enabled, `websocketRelayEnabled`, `relayKey` and `websocketRelayLimits`. `websocket-relay-limit` and `service-free-limit` errors give static actionable quota messages. Untrusted names must use `textContent`.

Policy tests cover public/private isolation, automatic invitation admission, moderation, asynchronous cancellation, owner spoofing, capacity, independent control, stale grants, strict encrypted envelopes, persistent quotas and cache tampering. Actual local workerd tests exercise TLS-independent WebSocket upgrades, SQLite persistence, healthy hibernation, consent, forwarding, sender identity, burst refusal and disconnect cleanup. The media test reads the actual persisted SQLite counters after runtime shutdown.

After deployment, `npm run test:deployed` creates and cleans up one disposable public room using production native HTTPS/WSS clients. It verifies automatic entry, actual AES-GCM encrypted packets in both directions, outsider refusal, independent consent/revoke, invitation rotation, blocking and host-leave cleanup. Its JSON report contains no invitation, key, device credential or raw packet. This explicit live test consumes a small amount of the free allowance; it is not part of ordinary unit tests and does not deploy anything.

These checks do not establish physical cross-network playback on the user's Windows PC, MacBook or iQOO. Test devices on separate networks, verify actual decoded screen frames and audible microphone audio in both directions, and test native capture/control/revoke separately. A forced-fallback browser test exercises the fallback engine but is distinct from two physical devices. Android emulator checks do not establish the iQOO's capture, microphone or battery-management behavior. The Glance-Port fullscreen and background-retention changes do not expand the free quotas above.
