# Device testing

Start with Windows and Android on the same Wi-Fi and matching release versions. Keep the desktop room host open, select its Wi-Fi address, paste the invitation on the phone and approve admission. Guest-network/client isolation can block this. Android joins a desktop-hosted room; closing that host ends the room.

The release APK uses the retained development signing key and can update the project's 0.1.0 APK. An APK downloaded from a CI artifact uses a temporary key and cannot update that installation. Use the published release APK for this test.

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

On the MacBook Air M4, use the Apple Silicon DMG. This test build is ad-hoc signed and unnotarized; use macOS's app review/open flow without disabling Gatekeeper globally. Grant **Microphone**, **Camera**, **Screen Recording** and **Accessibility** only for the features you test. Restart after permission changes when required. Test Mac hosting and joining separately. Its hosted build checks establish the packaged app starts, but physical Mac media and remote input still need this test.

## Phone presentation and input

Choose **Share screen** on Android and accept its system capture consent. Auralink requests the whole phone display so input coordinates match the shared picture; app-only selection is not offered by this build. Android 13+ also requests optional notification permission. Allow it if you want the **Stop sharing** notification outside the app.

First confirm the phone picture appears on the desktop. Then select it and request control. Enable the explicitly named **Auralink attended control** accessibility service when instructed; sideloaded apps may require **Allow restricted settings** in Android's app settings before enabling it. Return to Auralink and approve a fresh control request, including its separate native owner confirmation. Enabling Accessibility alone grants nobody access.

Test taps, short drags, scrolling, **Esc / Back**, **Home** and ASCII in a normal editable field. Support differs by target app; it is not unrestricted PC keyboard emulation. Protected screens and password editing remain outside support. After a rotation changes capture dimensions, request and approve control again.

Use the floating **Stop control** button and verify further input stops. Stop sharing and confirm both picture and input end. If notification permission is disabled, return to Auralink and select **Stop sharing**, or use Android's capture control where available. Also test lock, peer disconnect and system capture cancellation. Leaving Auralink without active screen sharing ends the phone room; new microphone/camera capture and owner approvals require the app in the foreground.

Report release, OS/WebView versions, network arrangement, approval steps and reproducible behavior. For audio include the failing direction, local meter response, speaker-test result and packet counts. For screen/control include whether a picture appeared, Accessibility was enabled and native confirmation completed. Build and synthetic tests do not establish these hardware outcomes.
