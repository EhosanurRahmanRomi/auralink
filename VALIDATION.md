# Validation boundaries

Tests record specific behavior. They do not certify unrestricted device control, physical media quality, internet reachability or absolute security.

## 0.2.0 software checks

| Check | What it establishes |
|---|---|
| Node protocol/input/bridge tests | Admission, four-person limit, secret/host separation, pinned invitations, input sequence/rate/expiry/revocation, Mac Command policy and Android RPC boundaries |
| Browser WebRTC mesh | Three real local peer connections with synthetic video, decoded frames, negotiation, mute/unmute and teardown |
| Browser two-way audio | Nonzero decoded synthetic microphone energy in both directions, microphone restart, stale-device fallback, persistent blocked-playback prompt and explicit recovery |
| Browser UI / mobile controller | Responsive layout, approval-before-capture, equipment settings, fullscreen, scoped data-channel input and revoked-session rejection |
| Java production code | Strict URI/certificate/validity policy, real pinned WSS admission, wrong pin rejection before transmitting room credentials, attended Android control confirmation/replay/expiry/rate checks |
| Android APK verification | Compiled native services/DEX, SDK29–36 manifest, reviewed permissions, valid stable development signature and exact bundled renderer hashes |
| Windows packaged checks | Genuine per-user non-elevating NSIS, payload integrity/source parity, actual packaged launch, local HTTPS start/stop and native helper availability |
| Mac hosted checks | Swift arm64 compiler/self-test, ad-hoc signing, DMG integrity, actual mounted bundle architecture/source parity and packaged launch/HTTPS teardown |

Evidence files are written under the ignored `test-results/` directory. CI publishes only selected top-level JSON/PNG evidence and test installers, excluding signing keys and credential fixtures. Hosted checks must be confirmed from the corresponding [Actions run](https://github.com/EhosanurRahmanRomi/auralink/actions); a local workflow file alone does not establish that it ran.

The source Electron permission smoke on this Windows machine reported microphone and camera access granted. That narrows the reported sound problem but does not verify the user's microphone hardware. The audio regression uses a synthetic 48kHz tone and measures actual decoded energy, rather than merely checking that an audio track exists.

Android MediaProjection/Accessibility code compiles against API36. JVM/static tests establish policy, not Android service runtime behavior. Physical iQOO phone capture, microphone, speaker, accessibility, rotation and background behavior require testing on that endpoint. See [the device guide](docs/TESTING.md).

Mac hosted build checks do not grant the user's TCC permissions or prove physical camera/microphone/screen capture and remote input on the MacBook. The free test package is ad-hoc signed and unnotarized. Android release APKs use the retained private local key; ephemeral CI APK keys differ and are not used as the update release.

## Remaining limits

- Direct same-network operation is the first target. No TURN relay or global directory is included.
- Desktop presentation targets at most 1440p/30; Android initially caps the longest edge at 1280/1920 with at most about 12fps and JPEG/video-frame conversion. Selection is a ceiling, not a measured-quality promise.
- Voice uses microphone audio. Desktop/phone system playback capture is absent.
- Normal desktop input and Android supported gestures/text cannot override UAC, lock screens, password fields, protected content or OS permission surfaces.
- ASCII/host layout limits apply; arbitrary Unicode and complete OS keyboard support are absent.
- Runtime dependency audit and broader build-tool advisories must be distinguished. No automated downgrade is used without validating its build effects.

No real-device success is inferred from synthetic tests, compilation, signatures or a scanner result. Release notes state the final build/run status and the boundaries still needing physical testing.
