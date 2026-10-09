# Desktop device testing

The active milestone is **Windows, Apple Silicon macOS and Android screen sharing, optional microphone audio and attended control**. Use matching versions. Camera calls are excluded. Package launch and synthetic media do not prove physical sound, MacBook permissions or iQOO battery behavior.

## Room and invitation

1. Click **Open a room**. No service-address/pairing form should appear. Screen and microphone remain off.
2. Share **Copy link** privately and open it on the other device. The landing page offers **Open Glance-Port** and code-copy fallback. Paste the invitation into **Join room** if OS link handling is unavailable.
3. Guest entry is automatic. Entry alone must never activate capture or input.
4. In **Manage people**, test **Remove**: guest media/input stop, but deliberate rejoin remains possible. **Remove & close invite** must invalidate that old code.
5. Test **Lock room** and **New invitation**. Existing guests stay when the invitation closes; old codes cannot admit newcomers.
6. Owner quit must end the room. A native link received during an existing room must not silently replace it or start capture.

An invitation is a long capability, not a guessable six-digit number. Blocking rejects the current connection and closes the old capability; it cannot permanently recognize a fresh anonymous app. Keep invitations out of reports/screenshots.

## Screen across different networks

Put Windows on home Wi-Fi/Ethernet and the Mac on a separate Internet connection. Same-PC/same-Wi-Fi clients do not establish different-network connectivity.

1. Share a full display. Confirm readable text and changing content on the receiver; an online badge is insufficient.
2. Record actual resolution, frame rate, codec, route and traffic from **Connection details** after ten seconds. While sharing in fullscreen, use **Stream** to try Auto, 720p, 1080p and desktop 1440p. Confirm the same share continues, the other quality selectors match, and received dimensions stay within the selected ceiling. Android is limited to a 1920-pixel long edge and needs a source display larger than 1280 pixels to demonstrate both live capture sizes.
3. Test Windows→Mac and Mac→Windows independently. A selector is a maximum; report received dimensions.
4. Scroll text and move a window to check motion/delay. Test minimizing/backgrounding and returning. Static content can hide a stalled encoder.
5. With blocked direct RTC, verify **Secure relay** or a useful failure. Direct success does not establish relay.
6. Test Wi-Fi change, endpoint quit and capture cancellation. Reconnect/new-room entry must not inherit capture or control.

Free relay budgets are finite. Current WebSocket limits reserve up to 512 MiB of wire media per room without a fixed time cutoff, plus global daily byte/message caps. The byte allowance is a hard budget: two 1080p/1440p feeds at illustrative 3–4.5 Mbps each can exhaust that room budget in roughly 6–9 minutes including base64url expansion, before audio/metadata. One presenter, static content or lower quality can use less. These are estimates, not promised durations. Exhaustion must stop fallback visibly. TURN remains optional/disabled until provider-enforced free quota, disabled overages and genuine expiry are verified.

Basic JPEG fallback is slower than encoded transport. Judge high-quality fallback by actual codec, resolution and motion; a 4 fps presentation does not satisfy that goal.

## Microphone and speaker

Microphones start off. Use headphones when devices are near each other.

1. Save input/output under **Settings → Sound**. Turn the microphone off/on after changing input.
2. Use **Check sound → Test microphone** and speak. The local test lasts at most ten seconds and records no file. Play the speaker test and confirm audible output.
3. Enable microphones deliberately. Speak Windows→Mac, then Mac→Windows; check both sender meter and actual receiving sound. Tap **Enable sound** when prompted.
4. Record sent/received counters and playback state. Packet counts or synthetic decoded energy alone do not prove physical speakers.
5. Test mute/restart, USB disconnect/system-default recovery and Bluetooth after wired/built-in equipment works.

Windows microphone privacy must allow desktop apps; macOS needs Microphone permission. A flat meter suggests input/permission; a moving meter without received packets suggests transport; packets without sound suggest output/playback. Report the failing direction and these observations.

## Attended input

Share a **full display**. Window presentation is viewing-only for native input. The controller requests control; the screen owner separately approves in the app and completes native consent. Room entry alone must never move the pointer.

Use a harmless editor: click, short drag, scrolling, English-US ASCII, Enter, Backspace and supported host shortcuts. Mac input needs **Accessibility** and capture needs **Screen Recording**; macOS 15+ Nearby may need **Local Network**. Restart after permission changes when required.

On the Mac, double-click a harmless Finder folder and confirm it opens; triple-click an ordinary editable word/line to test native click-count behavior. Verify Command-based copy/paste/select-all in that editor. Change display arrangement, resolution or scaling while sharing: capture/control must stop, and selecting a display again must require a fresh approval. Repeat with an external display being connected or removed if available.

Test each stop separately: owner **Stop control**, controller release, **Stop sharing**, disconnect, host quit and emergency shortcut. Further input must cease immediately. Replaced sockets/new rooms or expired 15-minute control leases require fresh consent. Secure/UAC desktops, locked screens and protected dialogs are outside support.

## Nearby and reporting

For a local baseline use **Other connection options → Nearby / private room → Nearby**, selecting the reachable host adapter. Share the invitation and approve admission. Keep Windows Firewall enabled. Guest-network isolation/wrong adapters can block this.

Report release, OS, host direction, networks, route/codec/resolution/fps, permissions and reproducible steps. For sound include meter, speaker test and failing direction; for input include full display vs window and native consent. Exclude invitations, pairing/device tokens, ICE credentials and account identifiers.

## Android acceptance

Install the matching APK as an update; it retains the project's local signing identity. On a recent Android System WebView, open a public room, use its invitation on Windows, enable microphones and test speech in both directions. Approve the separate Android screen-sharing prompt and notification permission, then switch to Home for a minute and return. The room, enabled microphone and selected share should remain; received motion/audio should advance while Home is foreground. A room without media should also survive Home/return without recreating its code.

Test sharing/control both directions. Phone input requires the attended Accessibility service, native confirmation and active full-display projection; turning on Accessibility alone must not grant control. Use Stop control, the sharing notification and End session to verify revocation. Test rotation and Bluetooth only after built-in audio and portrait capture work. Review iQOO's battery/background settings if the operating system stops the app; forced process termination cannot preserve WebView media. The [Android guide](../android/README.md) lists the supported gestures and capture ceilings. Automated emulator proof does not establish physical iQOO performance.

## Fullscreen and background acceptance

Open a shared screen using **Enter fullscreen**. The same video must fill the viewport with its aspect ratio preserved. The fullscreen toolbar provides microphone, sharing, control stop, sound, leave and exit actions. The keyboard drawer is optional and stays collapsed until opened. Approve control separately, test pointer mapping inside the displayed image, and check that empty image margins do not send clicks. Escape must exit locally and release held keys; Android Back must exit presentation and retain the current room. Leaving must exit presentation and release its keep-awake protection.

Minimize Windows or macOS for several minutes, then restore: the invitation, participant and live stream must be retained without a page reload. On Android, test Home/return with and without screen sharing and check ongoing notification controls. Test screen-off and iQOO battery management separately; an ordinary app switch is different from a force stop or process termination.
