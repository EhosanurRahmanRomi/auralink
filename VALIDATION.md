# Validation boundaries

Tests record specific behavior. They do not certify unrestricted device control, physical media quality, internet reachability or absolute security.

## 0.3.0 Internet beta checks

The current source adds a private Internet directory and coordinator alongside Nearby mode. The deployed service is reachable at `https://auralink-private-coordinator.auralink-internet-service.workers.dev` using normal certificate-chain and hostname verification. Pairing secrets and device tokens are not part of the public installers or source archive.

| Check | What it establishes |
|---|---|
| Coordinator policy tests | Hashed credentials, bounded private directory, admission and separate control consent, fixed absolute leases, cancellation during hashing/ICE fetch, forgotten-device races, persisted request/relay state and tampered-cache rejection |
| Actual workerd / SQLite tests | Production Workers WebSocket upgrades, real persistence/alarms, pending consent through idle time, and a mocked provider fetched through the Workers runtime with encrypted room-cache reuse |
| Live public native clients | Normal TLS/WSS, authenticated private presence, owner admission, sender identity, consent through an idle period, production heartbeat, exact native membership/grant, replay rejection and device cleanup |
| Local and public browser integration | Real WebRTC video/audio and encrypted input fixture between two contexts on this Windows PC; delayed capture, microphone permission and control approval cannot attach to a replacement room/share; rapid leave/rejoin is ordered by acknowledgment |
| Actual Electron integration | Production renderer/preload/native WSS, an approved native guest and actual capture of the Auralink app window; stopping capture and leaving retain directory presence |
| Native desktop lifecycle tests | Canceled asynchronous room preparation cannot replace a newer broker or leave a late listener running; stale screen enumeration cannot authorize a source |
| Android policy and bridge tests | Normal Internet CA/hostname verification remains separate from LAN pinning; room/socket loss invalidates consent immediately; capture IDs keep late results, frames and stops scoped to the originating share |

The deeper review fixed reproduced asynchronous room/capture/control races, stale callbacks, lost consent/relay state through hibernation and two fetch behaviors specific to Cloudflare. The live relay is still disabled. Its optional path is covered with a fake provider in the actual Workers runtime; that does not establish that Metered's free account supports provider-enforced credential expiry. The account's activated allowance was a 500 MB trial. No paid plan or overage option was enabled.

Current evidence is saved locally as `test-results/internet-public-native.json`, `internet-public-browser.json`, `internet-desktop.json`, `internet-browser.json` and the standard platform evidence files. A successful same-PC WebRTC path through a public signaling service does not establish media connectivity between different countries, restrictive routers or mobile carriers.

The earlier 0.2.0 native Android emulator result below remains historical evidence. During the 0.3.0 recheck, the local emulator produced graphics stalls and an unresolved capture-consent stage; bidirectional Opus transport passed in one run. Until a fresh complete 0.3.0 native runtime run succeeds, phone projection/control must be treated as awaiting that verification. The release report records the actual final package and runtime status; physical iQOO and MacBook tests remain necessary even after hosted checks pass.

## 0.2.0 software checks

| Check | What it establishes |
|---|---|
| Node protocol/input/bridge tests | Admission, four-person limit, secret/host separation, pinned invitations, input sequence/rate/expiry/revocation, Mac Command policy and Android RPC boundaries |
| Browser WebRTC mesh | Three real local peer connections with synthetic video, decoded frames, negotiation, mute/unmute and teardown |
| Browser two-way audio | Nonzero decoded synthetic microphone energy in both directions, microphone restart, stale-device fallback, persistent blocked-playback prompt and explicit recovery |
| Browser UI / mobile controller | Responsive layout, approval-before-capture, equipment settings, fullscreen, scoped data-channel input and revoked-session rejection |
| Java production code | Strict URI/certificate/validity policy, real pinned WSS admission, wrong pin rejection before transmitting room credentials, attended Android control confirmation/replay/expiry/rate checks |
| Android APK verification | Compiled native services/DEX, SDK29–36 manifest, reviewed permissions, valid stable development signature and exact bundled renderer hashes |
| Android 16 native runtime | Production non-debuggable APK, pinned admission, increasing microphone RTP, reverse audio acknowledgment, actual screen decode, separate native control consent, real Home input, changed background screen pixels, owner Stop/revocation and capture/audio cleanup |
| Windows packaged checks | Genuine per-user non-elevating NSIS, payload integrity/source parity, actual packaged launch, local HTTPS start/stop and native helper availability |
| Mac hosted checks | Swift arm64 compiler/self-test, ad-hoc signing, DMG integrity, actual mounted bundle architecture/source parity and packaged launch/HTTPS teardown |

Evidence files are written under the ignored `test-results/` directory. CI publishes only selected top-level JSON/PNG evidence and test installers, excluding signing keys and credential fixtures. Hosted checks must be confirmed from the corresponding [Actions run](https://github.com/EhosanurRahmanRomi/auralink/actions); a local workflow file alone does not establish that it ran.

The release installers were built from commit `474d8a400ce64c4ac597d01f15c38a1716c5400c` in [completed installer run 37628726376](https://github.com/EhosanurRahmanRomi/auralink/actions/runs/37628726376). All four jobs passed: unit/browser/desktop checks, Windows NSIS payload launch, Android compilation/package/security checks, and mounted Apple Silicon DMG launch. Release downloads match the hosted Windows/Mac package hashes. All 13 non-signature entries in the stable-key Android release APK match the hosted APK byte for byte; only signing metadata and ZIP offsets differ.

The source Electron permission smoke on this Windows machine reported microphone and camera access granted. That narrows the reported sound problem but does not verify the user's microphone hardware. The audio regression uses a synthetic 48kHz tone and measures actual decoded energy, rather than merely checking that an audio track exists.

The [completed native Android run 37633010991](https://github.com/EhosanurRahmanRomi/auralink/actions/runs/37633010991) installed and exercised the production APK on an isolated Android 16/API36 emulator. It passed native pinned room admission, real microphone RTP and reverse synthetic-host audio acknowledgment, actual 720×1280 MediaProjection video decoding, separately approved Accessibility input opening Android Home, new decoded pixels after an owner-visible volume action while Home remained foreground, the floating Stop control, rejection of genuinely transmitted stale-session input, owner capture stop and audio-route cleanup. The QA hierarchy observer preserves Accessibility services and does not modify or enable debugging in the production APK.

The emulator has no physical microphone or speaker. RTP proves transport, not audible hardware output. Physical iQOO microphone, speaker, capture, Accessibility, rotation and vendor-specific background behavior still require testing on that endpoint. See [the device guide](docs/TESTING.md). JVM/static tests establish the broader input policy; one real Home action does not prove every gesture or target application.

Mac hosted build checks do not grant the user's TCC permissions or prove physical camera/microphone/screen capture and remote input on the MacBook. The free test package is ad-hoc signed and unnotarized. Android release APKs use the retained private local key; ephemeral CI APK keys differ and are not used as the update release.

## Remaining limits

- Nearby supports same-network operation. The private Internet directory is deployed; media currently attempts direct WebRTC with STUN. TURN is disabled, so some network pairs cannot connect.
- Desktop presentation targets at most 1440p/30; Android initially caps the longest edge at 1280/1920 with at most about 12fps and JPEG/video-frame conversion. Selection is a ceiling, not a measured-quality promise.
- Voice uses microphone audio. Desktop/phone system playback capture is absent.
- Normal desktop input and Android supported gestures/text cannot override UAC, lock screens, password fields, protected content or OS permission surfaces.
- ASCII/host layout limits apply; arbitrary Unicode and complete OS keyboard support are absent.
- Runtime dependency audit and broader build-tool advisories must be distinguished. No automated downgrade is used without validating its build effects.

No real-device success is inferred from synthetic tests, compilation, signatures or a scanner result. Release notes state the final build/run status and the boundaries still needing physical testing.
