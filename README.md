<div align="center">

![Auralink — Your devices. One workspace.](docs/assets/auralink-banner.svg)

[![Build & checks](https://github.com/EhosanurRahmanRomi/auralink/actions/workflows/ci.yml/badge.svg)](https://github.com/EhosanurRahmanRomi/auralink/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/EhosanurRahmanRomi/auralink?include_prereleases&color=9ba7ff)](https://github.com/EhosanurRahmanRomi/auralink/releases)
[![MIT](https://img.shields.io/badge/License-MIT-71e7ef.svg)](LICENSE)

**Calls, presentations and remote assistance across your devices.**

[Download test builds](https://github.com/EhosanurRahmanRomi/auralink/releases) · [Testing guide](docs/TESTING.md) · [Architecture](docs/ARCHITECTURE.md) · [Report an issue](https://github.com/EhosanurRahmanRomi/auralink/issues/new/choose)

</div>

Auralink connects Windows, Apple Silicon Macs and Android phones in a room hosted by one desktop. The room owner approves every participant; each device chooses when to enable its microphone, camera or screen. Remote input requires another approval from the device owner.

**Experimental test release.** Check [validation and limits](VALIDATION.md) before relying on it. The application has no paid API, account backend, messaging, file sharing or recording service.

## Features

![Auralink desktop workspace](docs/assets/desktop-ui.png)

<details>
<summary>See the Android interface</summary>

<p align="center"><img src="docs/assets/android-ui.png" width="360" alt="The production Android APK running on Android 16, with its gradient room invitation interface"></p>

</details>

- Audio and camera calls for up to four participants.
- Desktop screen/window presentation with adaptive quality and connection diagnostics.
- Android display sharing through native system capture consent.
- Attended desktop pointer, keyboard and scrolling; Android gestures and supported editable text through an explicitly enabled accessibility service.
- Equipment selection, microphone levels and speaker checks.
- Separate control approval, immediate local stop and 15-minute control expiry.

## Download and connect

Get Windows Setup, the Android APK and the Apple Silicon DMG from [Releases](https://github.com/EhosanurRahmanRomi/auralink/releases). These are testing builds: Windows is unsigned, macOS is ad-hoc signed and not notarized, and Android uses the project's private development key. Review the publisher and SHA-256 checksums before installing.

Each release includes `SHA256SUMS.txt`, a source archive and `RELEASE-VERIFICATION.json` describing the exact package hashes, build commit and completed checks. Hardware testing remains separate from browser, emulator and packaged-launch checks.

1. Open Auralink on Windows or Mac and create a room. Start with both devices on the same Wi-Fi.
2. Select the reachable Wi-Fi/Ethernet address and share the invitation privately.
3. Paste it into **Join room** on the other device. The desktop owner approves admission.
4. Enable microphone/camera deliberately. Select equipment in Settings and use the room's **Check sound** tests if needed. Headphones help when devices are nearby.
5. Choose **Share screen** on the presenting device. Android displays the system capture prompt.
6. Select the shared device and request control. The owner reviews and confirms native permission. Android also needs Auralink Accessibility enabled through system settings.
7. Stop with the visible room controls or Android sharing notification. Desktop emergency stop: **Ctrl+Alt+Shift+Q** (Windows) / **Command+Option+Shift+Q** (Mac).

Enabling Android Accessibility alone grants nobody control. Input still requires an approved session and active phone share. Android capture requests the full phone display so control coordinates map to the shared screen. On macOS 15+, allow Auralink's Local Network permission for nearby connections. Grant Camera, Microphone, Screen Recording and Accessibility only for the associated feature; restart after permission changes if required. Use the OS review/open flow for the unnotarized DMG, rather than disabling Gatekeeper globally.

## Capabilities and limits

| Feature | Windows | macOS Apple Silicon | Android |
|---|---|---|---|
| Host room | Yes | Yes | Joins a desktop room |
| Audio/camera | WebRTC | WebRTC | WebView WebRTC + native audio route |
| Present screen | Screen/window | Screen/window with OS permission | MediaProjection → video frames → WebRTC |
| View / request control | Yes | Yes | Yes |
| Accept input | Normal desktop native helper | Normal desktop, Accessibility | Gestures/navigation/supported text fields, Accessibility |
| Separate approval / local stop | Yes | Yes | Yes |

Desktop sharing targets up to **1440p/30 fps**; camera calls up to **1080p/30 fps**. Initial Android sharing converts bounded native JPEGs into generated video frames, up to 1280 or 1920 pixels on the longest edge at about 12 fps. Update Android System WebView if prompted. It is not a 2K/30 native Android encoder. Actual quality can be lower; diagnostics show received resolution, fps, codec and route.

Voice uses the microphone; shared system audio is not included. Text input currently targets English US ASCII. Arbitrary Unicode/IME, every OS shortcut, Windows UAC, locked screens, protected Android surfaces and system permission dialogs are outside current control support. See [device tests](docs/TESTING.md).

Rooms are **peer-hosted**. Closing the host ends the room. Presence shows the current room, not every installation worldwide. Internet use requires a reachable host and compatible network paths. Optional STUN discovers candidates but cannot relay media. There is no TURN relay, router configuration, global directory or host migration; cross-network connectivity is not guaranteed.

## Build locally

Use Node.js 24, npm and Git. All source and outputs stay on your computer.

```sh
npm ci
npm start
```

If dependency install scripts are suppressed, run `node node_modules/electron/install.js` after installation.

```sh
# Windows per-user installer
npm run dist:win:setup -- --publish never

# Apple Silicon Mac, with Xcode command-line tools
npm run dist:mac -- --publish never
```

Android needs JDK 21, SDK platform 36 and build-tools 36.0.0:

```powershell
pwsh -NoProfile -File scripts/build-android.ps1 -AndroidSdkRoot YOUR_SDK_PATH -JdkDirectory YOUR_JDK_PATH
pwsh -NoProfile -File scripts/verify-android.ps1 -AndroidSdkRoot YOUR_SDK_PATH -JdkDirectory YOUR_JDK_PATH
```

See [Android build details](android/README.md). Outputs go to `release/`. Never upload `.private/`: it contains the stable APK signing identity. CI generates a temporary key, so its APK cannot update a stable-key local/release installation.

## Architecture and verification

The locally bundled interface runs in an isolated Electron renderer or locked-down Android WebView. Native clients pin room certificates. The broker enforces admission before signaling. Scoped input requires a peer/session, active capture, increasing sequence, bounded rate, expiry and revocation. See [architecture](docs/ARCHITECTURE.md).

```sh
npm test
npm run check
node tests/rtc-browser.cjs
node tests/ui-browser.cjs
node tests/mobile-control.cjs
node tests/android-security.cjs
```

Tests exercise real WebRTC with synthetic media, broker admission, native-input policy, certificate-pinned Java WSS and packaged source parity. Synthetic tests do not prove physical microphone/camera/phone or internet performance. [VALIDATION.md](VALIDATION.md) records actual checks. No absolute-security or "virus-free" claim is made.

## Contribute

Read [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md) and [the roadmap](docs/ROADMAP.md). Hardware audio tests, native Android encoding, connectivity and accessibility improvements are welcome.

Created by **[Ehosanur Rahman Romi](https://github.com/EhosanurRahmanRomi)**. Original code is [MIT licensed](LICENSE); bundled third-party notices are in `android/legal/`.
