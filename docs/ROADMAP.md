# Roadmap

The 0.3 private Internet beta adds optional free-hosted coordination alongside **Nearby** mode. The source implements a paired 32-device directory, four-person host-approved rooms, normal CA-validated Internet transport, independent owner control consent and verified 15-minute leases. Local coordinator policy/runtime checks pass. Public Cloudflare deployment and same-PC native/browser integration passed; cross-platform packaging and physical different-network validation are still being completed; source availability is not evidence that every worldwide connection works.

| Area | Next work |
|---|---|
| Media | Hardware/Bluetooth tests, native Android WebRTC encoder, adaptive motion/detail |
| Connectivity | Verify free-account deployment, physical cross-network/IPv6/mobile-carrier tests, reliable reachability diagnostics, provider-enforced relay quota/expiry |
| Input | More keyboard layouts/Unicode, improved Android gestures/text, multiple displays |
| Delivery | Windows signing, Apple Developer notarization, verified update delivery |
| Security | Independent review, device credential protection/recovery, owner-managed directory revocation, more lifecycle/parser abuse cases |
| Rooms | Better accessible pairing/onboarding, measured reconnection and host migration; larger groups after measurements |

The coordinator can use a free Cloudflare `workers.dev` address without a purchased domain. Its private paired-device directory is intentionally different from public global discovery. Media travels directly when possible; restrictive network pairs need a relay. TURN remains disabled until an owner configures and verifies a suitable free provider account.

The optional relay has expiring credentials, persisted issuance counters and a conservative whole-room deadline. These application guards do not establish a hard provider bandwidth or billing cap. Free quotas can be exhausted, and unlimited reliable worldwide high-resolution streaming at zero operating cost remains outside the beta's promise. No paid service, domain purchase or plan upgrade is required to develop or test direct-only mode.

Android still uses bounded 12fps JPEG-frame capture, 1280/1920 maximum long-edge presets, microphone-only audio and ASCII-focused attended input. A native hardware encoder, broader input support and physical Bluetooth/thermal/battery validation remain substantive work. Windows signing and Apple Developer notarization may require paid distribution credentials; the current test installers remain unsigned/ad-hoc signed.
