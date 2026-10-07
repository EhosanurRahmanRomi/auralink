# Android test companion

Auralink 0.3.0 uses a bundled Android WebView for WebRTC calls and the native Android platform for room connections, screen consent, audio routing and attended input. Android 10 or newer is required. Android can create or join an **Internet** room through the private hosted coordinator after device pairing. In **Nearby** mode, it joins a room hosted on Windows or macOS; it does not host the local signaling broker. Nearby connections pin the invitation certificate, while Internet connections verify the service's normal certificate chain and hostname.

## Try phone screen sharing

1. Install the APK. Create an Internet room after pairing, or join an Internet/Nearby invitation and wait for the room owner to approve you.
2. Tap **Share screen**. Android 13+ asks for optional notification permission so a visible **Stop sharing** action is available outside Auralink. Approve Android's separate screen sharing dialog. Full phone display sharing is requested so control coordinates match what the other participant sees.
3. Open another app. The active screen sharing foreground service keeps the existing room connected. Android displays its capture status and Auralink provides a **Stop sharing** notification action.
4. End sharing from Auralink, its notification or Android's screen sharing status. If you deny or disable notification permission, return to Auralink to stop sharing; recent Android versions also offer the system screen sharing status chip. This also ends any approved phone control. Moving Auralink to the background without active screen sharing ends its room and media session.

Phone capture is an initial MediaProjection → in-memory JPEG → generated VideoFrame → WebRTC implementation. Explicit frame writes avoid depending on the Activity's canvas compositor when the owner opens another app. A recent Android System WebView with `MediaStreamTrackGenerator` and `VideoFrame` is required; unsupported versions show update guidance before requesting projection. It defaults to a maximum 1280-pixel long edge at up to 12 frames per second. Selecting 1080p permits a maximum 1920-pixel long edge at the same frame limit. Actual frame rate depends on JPEG conversion, WebView, device load and network. It does not promise 2K or 30/60fps Android capture. Frames are never saved to storage. One pending frame, a 512 KiB JPEG ceiling and a delivery deadline bound memory and queues. Audio comes from the call microphone; phone app/system playback audio is not captured.

## Approve attended phone control

1. Keep full phone screen sharing active and accept a participant's control request.
2. If Android's accessibility service is disabled, Auralink offers **Open Settings**. Enable **Auralink attended control**, return to the room and approve a new request. Sideloaded apps can encounter Android's **Restricted settings** protection: review the app yourself in Android App info and use **Allow restricted settings** only if you trust this build. Auralink cannot enable or bypass this protection automatically.
3. Read and accept Auralink's native owner confirmation. Input begins only after the authenticated room broker confirms the exact participant and session.
4. Use the floating **Stop control** button to revoke input immediately. Sharing notification Stop also ends capture and control. Grants expire after 15 minutes and require new consent.

Supported Android input is a left pointer tap, a pointer drag replayed as a swipe on release, wheel scrolling, and ASCII text, deletion and cursor movement in ordinary editable accessibility fields. The **Esc / Back** tool button performs Android Back; **Home** opens the Android Home screen. The physical Escape key releases the controller's keyboard focus locally. Enter inserts a newline in multiline fields or invokes the field's IME action when available. Native right click, arbitrary hardware keyboard shortcuts, games requiring continuous live touch, multi-touch and apps that do not expose accessible editable fields are not supported. Password field editing and the lock screen are refused. Android and apps may hide protected content or restrict input. Changing capture dimensions revokes control and requires approval again. Already-dispatched platform gestures finish within 500 milliseconds; revocation prevents new or queued input immediately.

The accessibility service receives no event history and performs no background UI inspection or text logging. It reads only the currently focused editable field when an authorized text event needs to modify it. Enabling the service alone grants no remote access. A valid active full-display projection, native owner consent, room confirmation, exact participant/session binding, monotonic sequence numbers, rate limits and expiry are all required.

## Calls and audio

The call requests Android audio focus, sets communication mode and selects the phone speaker by default. Speaker routing uses `setCommunicationDevice` on Android 12+ and the compatible speakerphone API on older devices. Leaving the call restores the previous audio mode and abandons focus. Existing microphone/camera tracks can continue while explicit screen sharing is active; the foreground service declares only the permitted media types needed for that session. New capture permission and new owner approval require Auralink in the foreground.

If sound is missing, enable the microphone on both ends, use the app's audio unlock option if shown, check the chosen microphone and raise the call/media volume. Bluetooth and OEM audio behavior still require testing on your physical phone. Android 15/16 edge-to-edge system bars and keyboard insets are reserved natively to keep controls reachable.

## Validation and limits

The Android sources compile against API 36 with Java 8 bytecode. The signed APK uses the same local development signing identity as 0.1.0, allowing an in-place update. Automated JVM tests execute the production invitation, certificate pinning, real pinned TLS WebSocket admission and control authorization policy. Browser fixtures exercise Android bridge frame conversion, screen teardown and media/control integration separately. These tests do not establish physical iQOO capture, gesture dispatch or hardware audio performance. The release validation report states whether emulator and real device tests were available.

Platform references: [Android MediaProjection](https://developer.android.com/media/grow/media-projection), [AccessibilityService](https://developer.android.com/reference/android/accessibilityservice/AccessibilityService), [Android audio focus](https://developer.android.com/media/optimize/audio-focus), and [AudioManager communication routing](https://developer.android.com/reference/android/media/AudioManager#setCommunicationDevice(android.media.AudioDeviceInfo)).
