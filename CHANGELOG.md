# Changelog

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
