# Device testing

Start with Windows and Android on the same Wi-Fi and matching release versions. Keep the desktop room host open, select its Wi-Fi address, paste the invitation on the phone and approve admission. Guest-network/client isolation can block this.

## Audio

Select equipment and run Settings' microphone/speaker checks. Enable both microphones after joining. Confirm each local meter reacts, then test speech separately in both directions. Use headphones and enable listening if prompted. Report the failing direction, meter response, selected devices and media traffic; never share room secrets.

## Desktop presentation and input

Share a full desktop display. Select it on the other endpoint and request control. The owner confirms both app review and native consent. Test a harmless text editor: clicks, scroll, ASCII typing and Backspace. Revoke and verify further input stops. Mac needs Screen Recording and Accessibility; restart after permission changes when required.

## Phone presentation and input

Choose Share screen on Android and accept capture consent. For remote control choose the whole display. Enable the explicitly named Auralink Accessibility service when instructed; sideloaded apps may require **Allow restricted settings** in Android's app settings before enabling it. Return and approve a fresh control request.

Test taps, short drags, scrolling, navigation and ASCII in a normal editable field. Support differs by target app; it is not unrestricted PC keyboard emulation. Protected screens remain outside support. Stop through the sharing notification and confirm capture/input ends. Also test rotation, lock, disconnect and system capture cancellation.

Report release, OS/WebView versions, network arrangement, approval steps and reproducible behavior. Build and synthetic tests do not establish these hardware outcomes.
