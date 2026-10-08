# Changelog

## 0.4.0 — Desktop screen assistance (in development)

- Focused Windows↔macOS delivery on screen sharing, optional microphone audio and attended input. Removed camera controls, capture and device preferences; Android delivery is deferred while its source changes remain.
- Added one-click invitation rooms with automatic entry, host removal and invitation closure/rotation. Screen capture and native control remain independently consented.
- Added validated installed-app invitations and a fragment-only landing page; an incoming link does not silently replace an active room.
- Added bounded authenticated WebSocket fallback, strict native envelope gates and visible free-budget errors. Encoded high-quality screen performance is validated separately from the limited JPEG compatibility mode.
- Preserved screen/audio slots, tightened asynchronous teardown and kept desktop media active while minimized. Deferred Android retains its document and owner-visible session service during ordinary backgrounding.
- Converted browser coverage to actual decoded synthetic screen/audio and independent consent. Physical Windows↔Mac quality, sound, permissions and input require separate evidence.

## 0.3.1 — Guided Internet setup

- Creating an Internet room with a missing or invalid service address now opens the relevant Settings field with persistent setup instructions, before room admission or audio preparation begins.
- Unpaired Android devices go directly to setup when Create a room is selected. Desktop Nearby rooms retain their existing flow; desktop Internet rooms use the same setup guidance.
- Setup guidance closes blocking room/invitation dialogs, focuses the address or pairing field, and preserves custom service addresses and saved credentials. Paired devices can still reconnect when offline.

## 0.3.0 — Private Internet beta

- Added an optional **Internet** mode alongside existing **Nearby** rooms, with a Cloudflare Workers Free/SQLite Durable Object coordinator and a free public `workers.dev` address. A purchased domain is not required.
- Added private device pairing, hashed device credentials, retained online/offline host status, device forget/revocation and a 32-device private-directory cap. Room admission still requires the owner, and rooms remain limited to four approved people.
- Added normal CA-validated Internet transport, separate from Nearby invitation certificate pins. Signaling identities and roles come from authenticated membership; pending or unrelated devices cannot signal into a room.
- Kept remote control independent from room admission and native owner consent. Internet grants use verified 15-minute leases bound to device, peer, socket and room identities; healthy hibernation preserves valid consent, while expired/replaced bindings and disconnects revoke it.
- Added hibernatable heartbeats, bounded authentication/message handling, persisted room deadlines and policy/runtime tests for approval, spoofing, stale control, capacity, reconnection and lifecycle cleanup.
- Fixed asynchronous admission/capture/control races, canceled native room preparation, late capture-session callbacks and stale diagnostics. Room leave waits for the coordinator acknowledgment before a new admission.
- Preserved pending control requests and encrypted relay configuration through hibernation without extending their deadlines. Added actual Workers-runtime tests for platform-specific fetch behavior.
- Reserved dedicated audio/camera/screen transceivers and replaced their sources when devices change. This avoids repeated media-toggle negotiations; regression checks cover delayed signaling, bidirectional decoded audio and camera/screen separation.
- Added optional expiring Metered relay configuration, disabled by default, with persisted daily/monthly issuance limits and a whole-room session deadline. These application guards do not guarantee provider free billing or a byte quota; provider-enforced expiry, free allowance and overage behavior must be verified before enabling relay.
- Added free deployment instructions and a physical different-network test guide. Coordinator policy tests, real local workerd/SQLite/WebSocket checks and deployment dry run pass; the public Cloudflare service passed normal-TLS native and browser pairing/admission/consent tests. Two browser contexts on one Windows PC exchanged synthetic video and audio; physical different-network and platform tests remain outstanding.
- Verified the final Windows and Mac packages in hosted launch/source checks, exact Android release/hosted payload parity, two actual Electron apps exchanging synthetic media, and the production APK's native screen capture, attended Home control, revocation and audio transport on Android 16/API36.

The 0.2 hardware/input limits remain: a four-person mesh, Android 12fps capture with 1280/1920 maximum long-edge presets, microphone-only phone audio, ASCII-focused phone input and OS-protected surfaces. Installers remain test distribution without Windows signing or Apple notarization. Direct-only Internet connections do not cover every router/carrier pair, and unlimited free worldwide 2K streaming has not been established.

## 0.2.0 — Device assistance test release

- Added Android screen sharing with native MediaProjection consent, visible foreground service, bounded frames and stop action.
- Added attended Android accessibility input with explicit owner consent, peer/session binding, confirmation, expiry and local stop overlay.
- Added Android communication audio focus/routing and safe mobile insets.
- Improved audio playback unlocking, microphone/device errors, live levels, equipment checks and audio traffic diagnostics.
- Refreshed the interface with gradient surfaces, connected-device artwork and responsive layouts.
- Added Apple Silicon Mac packaging, permissions, Command editing support and actual bundle verification in CI.
- Added two-way decoded audio and phone-sharing bridge regression tests, repository documentation and public test releases.

Known limits include direct-network reachability, a four-person mesh, bounded 12fps Android capture, ASCII-focused input, OS-protected screens, and unsigned/unnotarized test distribution. Real endpoint quality remains dependent on hardware/WebView/network and should be checked using [the device guide](docs/TESTING.md).

## 0.1.0 — Initial local test

Peer-hosted rooms, desktop sharing, normal-desktop attended input and an Android call/viewing/controller companion. Android screen/control hosting was absent.
