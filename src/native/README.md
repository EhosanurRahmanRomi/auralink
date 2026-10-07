# Attended native input

`control.cjs` runs in Electron's **main process**, outside the renderer. It grants
one explicitly approved remote peer/session input access to a single selected
display. A renderer must never be allowed to supply arbitrary grants, display
bounds, executable paths, or authenticated sender identities.

```js
const { ControlGate, createAdapter } = require('./control.cjs');
const adapter = createAdapter();
const gate = new ControlGate(adapter, { onFailure: emergencyStop });

// Only after host-local approval; bounds come from Electron's screen API.
await gate.grant({ peerId, sessionId, display: { x, y, width, height } });

// Sender identity comes from the authenticated transport, not remote JSON.
gate.apply({ peerId, sessionId, event: { type: 'move', x: 0.5, y: 0.5, seq: 1 } });

// Host Stop, transport disconnect, screen change or session end:
await gate.revoke();
// Application shutdown:
await adapter.dispose();
```

Event types are `move`, `down`, `up`, `wheel`, `keydown`, and `keyup`. Pointer
coordinates are normalized to 0–1 inside the visible video content, excluding
letterboxing. Mouse buttons use browser numbering: 0 left, 1 middle, 2 right.
Keyboard events use whitelisted DOM `code` values. Scroll deltas are signed pixel
amounts bounded to ±1200. Every event must carry a positive, monotonically
increasing integer `seq` for that grant. There is a 300-event/second budget;
release events still pass when the budget is exhausted. Approvals expire after
15 minutes and require local approval again.

The Windows adapter lazily starts one hidden PowerShell process after approval.
It never requests elevation, bypasses execution policy, installs a service,
records keystrokes, or registers global input hooks. Its `SendInput` layout is
validated against the running process pointer size before it accepts input.
`SetCursorPos` uses the selected display's absolute coordinates. Packaging must
unpack `src/native/**/*` so PowerShell can read the script outside `app.asar`.

Validate C# compilation/layout without injecting any input:

```powershell
powershell.exe -NoLogo -NoProfile -NonInteractive -File .\src\native\windows-input.ps1 -ValidateOnly
```

On macOS, compile the helper on a Mac, then grant Accessibility access:

```sh
swiftc src/native/macos-input.swift -framework ApplicationServices -o src/native/macos-input
```

The Mac helper compiles on Apple Silicon in CI with safe self-tests and bundle
verification. macOS screen capture and Accessibility remain separate owner
permissions. Command editing keys are supported only by the Mac adapter; Windows
keys, function keys and OS-switching chords remain outside the allowlist.
Keyboard layout is the host's layout; Unicode text composition is not supported.

Windows secure desktop, UAC and higher-integrity applications may reject input.
Native helpers attempt to release all injected keys/buttons on normal revocation,
EOF and errors. Abrupt process/OS termination cannot guarantee release delivery.
Android hosts do not use this module. The native Android app uses its own
MediaProjection/Accessibility services and separately tested scoped policy.
Gestures, navigation and editable text differ from desktop keyboard emulation.

Tests in `tests/control.test.cjs` use fake adapters and never operate local input.

`node scripts/native-desktop-smoke.cjs` provides a separate Windows integration
check. It opens a dedicated local Electron QA window, types only `a1` into its
textarea, clicks its own button, restores the original pointer position, then
revokes the grant and verifies that further input is rejected. Each native event
is additionally bound to that window's foreground HWND. It writes evidence to
`qa/native-desktop-evidence.json`. Do not run it alongside another desktop test.

The controlled Windows integration check passed: trusted native key and click
events reached the QA window, the pointer was restored exactly, and input after
revocation was rejected. This verifies the native input path; it does not prove
remote network performance, permission behavior on other devices, or macOS input.
