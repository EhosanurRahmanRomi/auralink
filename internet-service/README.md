# Auralink private internet coordinator

This small service connects **paired, trusted devices across networks**. It supplies an online-device directory, room invitations, host admission and WebRTC signaling. Calls, screen video and remote-input data use encrypted WebRTC connections between participants; media is not uploaded to this Worker.

It is a private beta, limited to 32 paired devices and four approved people in each room. Installing Auralink alone does not enroll somebody in your directory. A device needs your private pairing key once, then uses its own server-issued device token. There is no public user search or automatic access to anyone's screen.

## How a connection works

1. The owner deploys this service to their **Cloudflare Workers Free account**. Cloudflare supplies a public `https://…workers.dev` address and a normal TLS certificate. No purchased domain is required.
2. Each trusted person enters that service address and the private pairing key in Auralink's Internet setup. The key is sent in a TLS-protected WebSocket frame, never in a URL. The service stores only a SHA-256 hash of each device token.
3. Paired devices see each other's names, online status and whether a room is available. Starting an internet room generates a new invitation key and a separate host capability, bound to the authenticated owner device.
4. A guest selects an available device or pastes an invitation. The owner sees an admission request. Until the owner approves, that guest receives no room signaling.
5. WebRTC attempts a direct connection using STUN. If an optional free relay has been configured and enabled, TURN provides a fallback for restrictive routers and mobile networks.
6. Remote control requires a second, independent permission from the actual screen owner. Leaving, disconnecting, closing the room or revoking permission invalidates that grant. The directory connection can remain online after a room ends.

Direct-only mode can work internationally without port forwarding, but some network combinations need TURN. It is not a guarantee that every pair of networks will connect, and this service uses Cloudflare infrastructure rather than being fully decentralized.

## Free deployment

Use Node.js 22 or newer on Windows 11, macOS or Linux. From the project directory:

```powershell
cd internet-service
npm ci
npm test
npm run test:runtime
npm run check
npx wrangler login
```

`wrangler login` opens Cloudflare's supported OAuth login. Cookies are not needed. Remain on the **Workers Free plan**; do not enable a paid plan to deploy this project. The SQLite Durable Object migration in `wrangler.jsonc` is compatible with the free plan.

Generate a strong private pairing key locally:

```powershell
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))"
npx wrangler secret put PAIRING_KEY
npm run deploy
```

Paste the generated key when the secret command asks. Save it in your password manager and share it only with people you want in your private directory. Keep it out of screenshots, GitHub, invitations and installer assets. Wrangler prints the public service address after deployment. Enter that address in Auralink on every device. A deployed, configured service returns this identity-free health response:

```json
{"service":"auralink-internet","protocol":1,"status":"ok"}
```

at `GET /internet/health`. WebSockets use `GET /internet/ws`; query strings are refused. The service uses normal platform TLS, so it does not use the LAN room's self-signed certificate pin.

For local development, copy `.dev.vars.example` to `.dev.vars`, replace the pairing-key placeholder, and run `npm run dev`. The default local address is `http://localhost:8787`. Keep local development credentials separate from deployment credentials. `.dev.vars`, runtime data and dependencies are ignored by Git.

## Relay and the zero-cost boundary

**Relay is disabled by default.** The shipped configuration contacts no TURN credential provider and returns only public STUN configuration. Cloudflare Free quotas are finite: the service becomes unavailable when the applicable free limits are exhausted. Free tiers are useful for a small beta, not unlimited worldwide video conferencing. Check the current [Cloudflare Durable Objects free limits](https://developers.cloudflare.com/durable-objects/platform/pricing/) before deployment.

Optional Metered relay setup uses a **credential-scoped API key for an already-created, expiring TURN credential**. The account-wide secret key is never requested or exposed by this implementation. Before enabling relay, verify your Metered account's free allowance and what happens when it is exhausted. Do not enable billing or accept paid overages for this project.

1. In your Metered dashboard, create an expiring credential and wait for propagation before testing. Confirm whether expiring credentials and credential retrieval are available on your account's free plan. This service does not upgrade your account or create paid credentials.
2. Set `METERED_APP_DOMAIN`, `METERED_API_KEY` and `METERED_CREDENTIAL_EXPIRES_AT` with `npx wrangler secret put NAME`, one command per secret. The domain must be your app's `…metered.live` hostname, without a scheme or path. The expiry must be the **actual provider-enforced credential expiry**, in ISO UTC form, no more than 24 hours ahead. Setting an expiry here does not make a static provider credential expire.
3. Keep `RELAY_ENABLED` false until your free-plan and quota behavior are verified. When ready, set it to `"true"` in `wrangler.jsonc`, then redeploy.

The default app limits are **four provider credential fetch attempts per UTC day**, **60 per UTC month**, and a **10-minute room limit when TURN is offered**. Approved room participants share the room's fetched ICE configuration. Attempts are counted before fetching, including provider failures. Limits persist in SQLite. The whole room ends at its saved relay deadline, even across a restart and even if a participant's selected WebRTC route happens to be direct. The server cannot reliably prove which route every client is using, so offering relay activates this conservative room limit. You can reduce these limits in `wrangler.jsonc`; the implementation caps session duration at 30 minutes.

These are **issuance and application-session limits, not a byte meter or a provider billing cap**. A copied TURN username/password could consume the provider allowance until its actual expiry. The provider's enforced free quota, disabled overages and credential expiration are required for a strict spending boundary. High-resolution streams can use several GB per hour. When the provider fails, a credential expires or an app allowance runs out, Auralink falls back to direct-only configuration; it never selects a paid provider automatically.

See Metered's [credential retrieval API](https://www.metered.ca/docs/turn-rest-api/get-credential/) and [expiring credential guidance](https://www.metered.ca/docs/turnserver-guides/expiring-turn-credentials/). Server-side responses include only the WebRTC ICE servers, username and temporary password needed by approved participants. Provider API keys are never returned to the client. Provider URLs and error details are not logged.

## Security and lifecycle

- A maximum of eight unregistered sockets can wait for authentication, and 64 total sockets can connect. Unauthenticated sockets expire after ten seconds. Overlapping authentication attempts on one socket are refused. Application messages are text JSON, bounded to 64 KiB and 150 messages per five seconds per socket; automatic heartbeat replies do not execute application code.
- A registered device has one live socket. A second valid login replaces the old connection and ends its participation. **Forget this device** removes the server registration and invalidates its token; rejoining requires pairing again.
- Room IDs do not authorize admission. Invitation keys and host tokens are persisted as hashes, and a copied host capability cannot impersonate a different device. Pending guests cannot signal, grant control or admit themselves.
- Peer IDs, roles and signal senders are derived from authenticated membership. Cross-room signals and stale control requests are refused. Native screen-sharing and input permissions remain the screen owner's responsibility.
- SQLite stores device names, token hashes, room capability hashes and relay issuance counters. Optional room ICE configuration is encrypted with AES-GCM under a key derived from the server pairing secret, bound to its room/provider/expiry, and discarded when expired or invalid. Hibernation reuses that cache without another provider fetch or extending the original room deadline. WebSocket attachments restore approved membership and pending control requests through Cloudflare hibernation. Control consent has an absolute 15-minute lease bound to both authenticated device IDs, peer IDs, socket connection IDs and the room. Healthy hibernation preserves a verified, unexpired lease. An expired lease, replaced socket, changed device or changed room explicitly revokes control; the owner must consent again. A missing host ends the room. Unverified grant state never silently resumes.
- Clients send exact `{type:"ping"}` messages every 30 seconds; Cloudflare replies automatically while the object hibernates. Alarms read those automatic-response timestamps to refresh the idle lease. Idle sockets expire after two minutes. Durable Object alarms enforce authentication, pending admission, idle and relay deadlines while allowing hibernation between events. There are no permanent JavaScript timers or polling loops keeping the object awake.
- Worker observability is disabled in this configuration, and application code does not log invitation contents, signaling, device tokens or provider keys. Hosting providers still handle network metadata according to their own policies.

## Protocol

The first socket message is either `{type:"pair",pairingKey,name}` or `{type:"register",deviceId,deviceToken,name}`. A successful pairing emits `paired` with the new credentials, then `registered`. Both authentication paths send the private `presence` directory. Store the device token locally; never put it in an invitation.

| Client message | Result |
| --- | --- |
| `create-room` with optional room `name` | `room-created` with `roomId`, `roomKey`, `hostToken`, `name` |
| `join` with `roomId`, `roomKey`, optional owner `hostToken` | Owner `welcome`, or guest `pending` and owner `join-request` |
| `join-device` with paired owner `deviceId` | Same pending guest approval |
| `approve`, `reject`, `kick` with `peerId` | Owner-only admission actions |
| `signal` with `to`, `data` | Relayed only to an approved peer in the same room; sender rewritten |
| `control-request` with `to` | Owner receives request with server-issued `requestId` |
| `control-response` with `to`, `requestId`, `accepted`, owner `sessionId` | Independent owner grant or denial |
| `grant-control` with `peerId`, own `targetId`, owner `sessionId` | Explicit grant issued by the actual screen owner |
| `control-revoke` with optional controller `to` | Owner revocation |
| `ice-request` | Approved participant receives `ice-config` |
| `leave` | Ends room participation; sends `room-left`; directory remains connected |
| `forget` | Deletes own registration, sends `forgotten`, closes socket |
| `ping` | `pong` and idle lease refresh |

`welcome` includes `{selfId,hostId,room,peers,iceServers,relayEnabled,relaySecondsLimit}`. ICE configuration is ready before welcome, so the client can construct its WebRTC connections safely. `presence.devices` contains only `{id,name,online,hosting,roomId}`, including retained offline registrations. Names are untrusted display text and must be rendered with `textContent`.

## Verification

`npm test` runs policy/security tests covering invalid pairing/token, hash-only persistence, copied host-token impersonation, approval, sender identity, four-person capacity, independent control consent, revoke/disconnect, stale cross-room requests, device forget, simultaneous device-cap enforcement, payload/rate limits, optional relay limits, verified hibernation restoration and refusal of expired/replayed control bindings. Alarms revoke expired control even when both devices remain online, without ending the call.

`npm run test:runtime` exercises the actual local workerd/Miniflare runtime with SQLite storage, WebSocket upgrades, authentication, admission, signaling, control consent/revoke, host disconnect, offline presence and forgetting. `npm run check` performs a Wrangler deployment dry run without publishing anything.

These tests do not prove international media connectivity on your physical Windows PC, iQOO phone and MacBook. After deployment, test from separate networks, then test a verified free TURN relay and an owner-approved control session. Keep the account free and measure provider usage before inviting more people.
