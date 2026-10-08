# Validation boundaries

Tests record specific behavior. They do not certify unrestricted device control, physical media quality, internet reachability or absolute security.

## 0.4.1 recovery revision

The repaired source has unit coverage for a stopped microphone during sender attachment, full media queues losing enable/mute state, failed or stalled native screen readers, and failed direct sender replacement. Screen recovery also covers a reader failing after compressed streaming has started: a fresh encoder resumes encrypted frames at the same resolution. Local browser tests decode non-silent microphone audio in both directions and recover after interruption. Actual Windows app-window capture passes the shipped encrypted screen encoder/decoder using both the normal track processor and a deliberately forced ImageCapture fallback; original capture ownership is preserved until Stop sharing. These checks do not establish the user's physical Mac microphone or capture permissions.

The current production Electron live test uses two isolated Windows apps, the actual main/preload and native public WSS, blocked direct RTC, decoded synthetic microphone tones in both directions, microphone restart and synthetic 1440p H.264 screen playback above 15 measured frames per second in each direction. It waits for the relay route before measuring media; temporary direct-track metadata during fallback is not treated as delivered audio. Source hashes and measurements are recorded separately from hardware or different-network acceptance.

The Mac package check now reads the actual signed app and audio helper entitlements. Each release report records the CI result and frozen source. Physical Windows↔Mac on different networks remains the final user-device acceptance test, and must not be inferred from generated-media CI or same-PC production tests.

Android 0.4.1 is included with its public invitation flow and separate native foreground room/call and projection services. The production audio route has JVM coverage for focus refusal/loss/recovery, rejected device selection and restoration after native exceptions. Its APK is checked for manifest, permissions, signature, DEX and renderer source parity, then exercised separately in the hosted native runtime workflow. Release assembly requires the actual APK's public relay media, Home/return, projection rotation, consented Accessibility input and owner revocation stages to pass. Physical iQOO sound and manufacturer battery restrictions remain unverified; Android capture does not promise desktop 1440p/30 fps.

Cloudflare Realtime TURN remains disabled because the inspected activation form requires a payment method and billable overages. Its backend adapter has mocked-provider tests only. No paid subscription, card or overage option was enabled. The default retains finite Workers Free media allowances.

## 0.4.0 desktop screen-sharing revision

The current milestone is Windows and Apple Silicon macOS: open an invitation room with one click, share its link, and let the invited device join without an admission prompt. Each screen owner deliberately starts capture and separately approves remote control. Camera calls are removed; microphone audio remains optional. Android work is retained in source and deferred from this release milestone.

The current source passes 156 unit tests covering invitation parsing, admission, revocation, encrypted media, codec resource limits and native lifecycle. The native display check also covers Electron 44.6's legacy empty-device permission stage: it requires a current owner-selected source and still rejects camera requests. Relay input has an independent bounded queue so a normal shifted-key sequence does not collide with audio; failed delivery or receive overflow revokes control. Adaptive capture pacing uses elapsed time so lowering frame rate cannot stall a long-running session. A continuously blocked encoder retries a supported backend with bounded cleanup. The initial blocked-P2P browser test displayed screen pixels and decoded microphone audio over the limited JPEG compatibility path; that result alone did not establish compressed performance.

The public coordinator now enables invitation rooms and encrypted WebSocket relay. Its deployed smoke passes normal HTTPS/WSS validation, automatic invitation entry, encrypted duplex packets, separate control consent, revocation, removal and room teardown. Two actual Electron apps using the production preload and native WSS displayed synthetic 2560×1440 H.264 screen frames at 26.3 and 27.3 fps in the latest measured run, one presenter at a time in each direction. Direct WebRTC was deliberately restricted to relay-only without TURN and then closed; no browser socket or hardware sensor was substituted for the native transport. Source hashes and actual playback-frame counts are saved in `test-results/invitation-electron-live.json`.

Every release assembly requires a matching frozen-source CI run, Windows installer source/payload launch checks, mounted Apple Silicon DMG checks and current media evidence. Consult the release's `RELEASE-VERIFICATION.json` for the completed run and artifact digests. Physical Windows-to-Mac tests on different networks remain required; same-PC tests do not establish the user's MacBook permissions, native input or carrier connectivity. Earlier release reports below describe historical binaries.

The default relay has finite shared room/day allowances. It forwards client-encrypted packets using keys issued by the coordinator; the coordinator is a trusted key distributor. This is not a claim of encryption against a malicious key distributor. No paid relay, card or overage plan has been enabled.

## Historical 0.3.0 Internet beta checks

The 0.3.0 source added a private Internet directory and coordinator alongside Nearby mode. The service used normal certificate-chain and hostname verification. Pairing secrets and device tokens were excluded from the public installers and source archive.

| Check | What it establishes |
|---|---|
| Coordinator policy tests | Hashed credentials, bounded private directory, admission and separate control consent, fixed absolute leases, cancellation during hashing/ICE fetch, forgotten-device races, persisted request/relay state and tampered-cache rejection |
| Actual workerd / SQLite tests | Production Workers WebSocket upgrades, real persistence/alarms, pending consent through idle time, and a mocked provider fetched through the Workers runtime with encrypted room-cache reuse |
| Live public native clients | Normal TLS/WSS, authenticated private presence, owner admission, sender identity, consent through an idle period, production heartbeat, exact native membership/grant, replay rejection and device cleanup |
| Local and public browser integration | Real WebRTC video/audio and encrypted input fixture between two contexts on this Windows PC; delayed capture, microphone permission and control approval cannot attach to a replacement room/share; rapid leave/rejoin is ordered by acknowledgment |
| Actual Electron integration | Production renderer/preload/native WSS, an approved native guest and actual capture of the Auralink app window; stopping capture and leaving retain directory presence |
| Two actual Electron apps | Separate fresh app profiles, production native WSS and owner admission, bidirectional displayed synthetic camera video and decoded microphone energy, microphone restart and acknowledged device cleanup; production permission rules remain unchanged |
| Native desktop lifecycle tests | Canceled asynchronous room preparation cannot replace a newer broker or leave a late listener running; stale screen enumeration cannot authorize a source |
| Android policy and bridge tests | Normal Internet CA/hostname verification remains separate from LAN pinning; room/socket loss invalidates consent immediately; capture IDs keep late results, frames and stops scoped to the originating share |

The 0.3.0 review fixed reproduced asynchronous room/capture/control races, stale callbacks, lost consent/relay state through hibernation and two fetch behaviors specific to Cloudflare. TURN was disabled in that release. Its optional path was covered with a fake provider in the actual Workers runtime; that did not establish that Metered's free account supported provider-enforced credential expiry. The account's activated allowance was a 500 MB trial. No paid plan or overage option was enabled.

Current evidence is saved locally as `test-results/internet-public-native.json`, `internet-public-browser.json`, `internet-desktop.json`, `internet-electron-media.json`, `internet-browser.json` and the standard platform evidence files. A successful same-PC WebRTC path through a public signaling service does not establish media connectivity between different countries, restrictive routers or mobile carriers.

The 0.3.0 installers were built from commit `0e2f90f72eedf79726aa7eee4aac27b7f6a25a12` in [completed installer run 37656790354](https://github.com/EhosanurRahmanRomi/auralink/actions/runs/37656790354). All four jobs passed. Windows and Mac downloads match the hosted package hashes; all 15 unsigned entries of the stable-key Android release APK match the hosted test APK exactly. The release report separately records the archive commit and build commit and verifies that compiled production sources match.

The [completed 0.3.0 native Android run 37657967987](https://github.com/EhosanurRahmanRomi/auralink/actions/runs/37657967987) exercised that production APK on an isolated Linux-hosted Android 16/API36 emulator. It passed owner-approved MediaProjection with actual 720×1280 screen decoding, increasing phone microphone Opus RTP and reverse host-tone acknowledgment, separately confirmed Accessibility input opening Home, changing decoded pixels while Home remained foreground, floating Stop/revocation, stale-session input rejection and capture/audio cleanup. No baseline or receiver renderer override was used. Earlier local Windows emulator graphics stalls remain failed local evidence; they are not counted as successful runtime tests.

The emulator has no physical microphone or speaker. Its audio check establishes transport and communication routing, not audible hardware output. Physical iQOO and MacBook media, permissions, rotation, input and background behavior still need owner testing, as do genuinely different-network Internet connections. The 0.2.0 results below remain historical evidence.

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

- Internet rooms prefer direct WebRTC with STUN, then use compressed encrypted WebSocket relay when direct transport fails. TURN is disabled. HTTPS/WSS blocking, service outages and finite shared budgets can still prevent connections.
- Desktop presentation targets at most 1440p/30. The latest measured same-PC compressed result is 26–27 fps; source capability, decoder, network and congestion can reduce it. Engines without a common video codec use the explicitly labeled 4 fps JPEG compatibility path. Android is deferred from the current release.
- Voice uses microphone audio. Desktop/phone system playback capture is absent.
- Desktop input follows OS permission boundaries, including the Windows secure/UAC desktop and locked screens. It does not inspect or block ordinary desktop password fields. Android refuses password-field editing and cannot bypass lock screens, protected content or OS permission surfaces.
- ASCII/host layout limits apply; arbitrary Unicode and complete OS keyboard support are absent.
- Runtime dependency audit and broader build-tool advisories must be distinguished. No automated downgrade is used without validating its build effects.

No real-device success is inferred from synthetic tests, compilation, signatures or a scanner result. Release notes state the final build/run status and the boundaries still needing physical testing.
