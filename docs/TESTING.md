# Device testing

Use matching app versions on every endpoint. The 0.3 beta has **Nearby** and **Internet** connection modes. Start with the Nearby baseline below, then test Internet from genuinely different networks. Microphone, camera and remote-input permission remain separate from connecting or admitting a participant.

## Current verification status

The private Internet coordinator has passing policy/security tests, real local workerd/SQLite/WebSocket tests and a Wrangler deployment dry run. Public Cloudflare deployment and same-PC native/browser Internet integration checks passed; physical different-network and cross-country tests remain pending. The 0.2 packaged builds and synthetic media tests establish specific build/runtime outcomes, not every physical microphone, speaker, camera or network combination. Record what actually passed on your devices before treating the beta as ready for everyday use.

## Nearby baseline

Start with Windows and Android on the same Wi-Fi and matching release versions. Select **Nearby**, keep the desktop room host open, select its Wi-Fi address, paste the invitation on the phone and approve admission. Guest-network/client isolation can block this. Nearby Android joins a desktop-hosted room; closing that host ends the room.

If Windows asks about network access, allow Auralink on your trusted private network. Both the room connection and WebRTC media need network access; keep Windows Firewall enabled. On the phone, the microphone, camera, sharing and leave controls appear above the presentation area as soon as admission completes.

The release APK uses the retained development signing key and can update the project's 0.1.0 APK. An APK downloaded from a CI artifact uses a temporary key and cannot update that installation. Use the published release APK for this test.

## Internet from different networks

Follow [the free service setup](../internet-service/README.md) after the coordinator is deployed. It supplies a public `workers.dev` address and normal TLS, so you do not need your own domain or a Nearby certificate pin. Keep the account on the free plan. A direct-only deployment may connect many network pairs but cannot cover every restrictive router or mobile carrier.

1. Put Windows on home Wi-Fi and Android on **mobile data with Wi-Fi turned off**, or use two separate internet connections. Two devices on the same Wi-Fi do not establish different-network connectivity. Later repeat with the Mac on another network and, when possible, a trusted person in another country.
2. On each device, configure **Internet** with the same deployed service address and its private pairing key. Keep the app open. Confirm the device appears in the private paired-device list. The directory admits at most 32 paired devices. Share the pairing key only with trusted testers; do not post it publicly or include it in a bug report.
3. Start an Internet room on one device. On the other, select that available host or paste its Internet invitation **inside Auralink**. The coordinator provides protocol endpoints, not a hosted browser calling page. Confirm the guest waits and the owner sees the expected name. Try **Decline** first: the guest must receive no call or screen. Request again, then approve.
4. Test voice in both directions using the audio steps below. Enable cameras separately, then share one screen. Check that actual video updates and speech is audible, rather than relying only on connection status or packet counters.
5. Inspect **Connection details**. Record whether the selected WebRTC route is direct or relayed when the app supplies that diagnostic. Success with a direct connection does not prove TURN fallback, and success on one carrier does not establish every network combination. Never include ICE credentials, invitations or pairing/device tokens in a screenshot.
6. Request control of a shared full display. Confirm that room admission alone cannot move the owner's pointer or phone. Complete the separate app/native owner consent and perform only the harmless input steps below. Revoke, stop sharing and disconnect in separate tests; each must stop further remote input.
7. Test directory lifecycle: leave a room while remaining online, reconnect without inheriting old control, and close the host app. Its room must end and its directory entry must become offline. **Forget this device** must remove its registration; the old token must no longer reconnect it. Ordinary healthy coordinator hibernation preserves a verified consent lease. At 15 minutes, Internet control must expire and require fresh owner consent while the call may continue.
8. Add a third and fourth approved person. Try a fifth request: the four-person room cap includes its owner. Confirm declined/pending devices cannot signal, receive media or control another participant.

Test Windows hosting and joining, Mac hosting and joining, and Android Internet hosting and joining separately. Phone background/projection and OS permission limits still apply. Use headphones for the first audio test, keep the devices charged and note OS/WebView versions.

### Optional free relay fallback

TURN is disabled by default. Do not enable it until your provider account's free quota, overage behavior and genuinely expiring credential are verified. Configure it using the service guide; API keys belong in Worker secrets, not the app or source repository. An issuance/session limit in Auralink does **not** guarantee a provider billing cap or bound all copied-credential usage.

To establish fallback, use a network pair that cannot connect directly and verify that the selected route actually becomes relayed. If direct traversal already works, report that TURN was not exercised. Start with a short audio-only session, inspect the provider's usage dashboard, then test video/screen sharing briefly within the available free allowance. Do not spend the whole allowance on a long maximum-quality test.

The default optional relay room deadline is ten minutes from offering usable TURN configuration. **The whole room ends at that deadline even if its eventual route is direct**, because the coordinator cannot reliably prove every client's route. Check that capture/input stop, the directory remains usable and a new room gets a fresh admission. Expired credentials, provider errors or exhausted app issuance limits must fall back to direct-only behavior; no paid fallback should be selected.

## Audio

Microphones start off after admission. Test voice before starting screen sharing:

1. Choose the microphone and audio output in **Settings → Camera and sound**, then **Save preferences**. If you change the microphone during a call, turn it off and on to apply the choice.
2. In the room, select **Check sound → Test microphone** and speak. The test runs for at most ten seconds; it does not record a file. Select **Play speaker test** and confirm the tone is audible. Check Windows/macOS microphone privacy permission or Android's microphone permission if the meter stays still.
3. Enable the microphone on each device. Use headphones when the devices are nearby. On Android, start with **Speaker on**, raise the call/media volume, and test built-in audio before trying Bluetooth.
4. Speak from Windows to the phone, then from the phone to Windows. Confirm each sender's local microphone meter moves. Tap **Enable sound** on the receiving device if the prompt appears.
5. Open **Connection details** on each device. While speaking, compare **Audio sent**, **Audio received**, **Microphone level** and **Playback**. Packet counts should increase; increasing counts alone do not prove the speaker is audible.

If the sender's meter is flat, check its selected microphone and system permission. If its meter moves but the receiver has no audio packets, report that direction and the connection state. If packets arrive but speech is silent, report the receiving output, speaker-test result and Playback status. Never include an invitation or room key in a report.

## Desktop presentation and input

Share a full desktop display. A window-only presentation does not accept native desktop control. Select the shared display on the other endpoint and request control. The owner confirms both app review and native consent. Test a harmless text editor: clicks, scroll, ASCII typing and Backspace. Revoke and verify further input stops.

On the MacBook Air M4, open the Apple Silicon DMG, drag Auralink into **Applications**, and launch it from there. This test build is ad-hoc signed and unnotarized; use macOS's app review/open flow without disabling Gatekeeper globally. On macOS 15+, allow Auralink under **Privacy & Security → Local Network** when connecting nearby devices. Grant **Microphone**, **Camera**, **Screen Recording** and **Accessibility** only for the features you test. Restart after permission changes when required. Test Mac hosting and joining separately. Its hosted build checks establish the packaged app starts, but physical Mac media and remote input still need this test.

## Phone presentation and input

Choose **Share screen** on Android and accept its system capture consent. Auralink requests the whole phone display so input coordinates match the shared picture; app-only selection is not offered by this build. Android 13+ also requests optional notification permission. Allow it if you want the **Stop sharing** notification outside the app.

First confirm the phone picture appears on the desktop. Then select it and request control. Enable the explicitly named **Auralink attended control** accessibility service when instructed; sideloaded apps may require **Allow restricted settings** in Android's app settings before enabling it. Return to Auralink and approve a fresh control request, including its separate native owner confirmation. Enabling Accessibility alone grants nobody access.

Phone capture remains limited to 12 fps and a maximum 1280/1920-pixel long edge according to the preset. Test readable text, motion and rotation at these actual limits; do not report this as native 2K/30fps capture. The phone shares microphone audio rather than Android system sound.

Test taps, short drags, scrolling, **Esc / Back**, **Home** and ASCII in a normal editable field. Support differs by target app; it is not unrestricted PC keyboard emulation. Protected screens and password editing remain outside support. After a rotation changes capture dimensions, request and approve control again.

Use the floating **Stop control** button and verify further input stops. Stop sharing and confirm both picture and input end. If notification permission is disabled, return to Auralink and select **Stop sharing**, or use Android's capture control where available. Also test lock, peer disconnect and system capture cancellation. Leaving Auralink without active screen sharing ends the phone room; new microphone/camera capture and owner approvals require the app in the foreground.

Report release, OS/WebView versions, Nearby/Internet mode, network arrangement, approval steps and reproducible behavior. For Internet include direct/relay route when verified, each device's network and whether a provider/session limit was reached. For audio include the failing direction, local meter response, speaker-test result and packet counts. For screen/control include whether a picture appeared, Accessibility was enabled and native confirmation completed. Build and synthetic tests do not establish these hardware outcomes. Exclude service secrets, invitations, device tokens, ICE credentials and account identifiers.
