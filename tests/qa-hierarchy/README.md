# Isolated hierarchy observer

This test-only APK instruments its own `local.auralink.qa` package. It observes all interactive window roots with `Instrumentation.getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES)` so inspecting native consent and the floating Stop control overlay does not suppress Auralink's Accessibility service. It never injects input or modifies the production APK.

With JDK 21, Android platform 36 and build-tools 36.0.0 installed:

```sh
node tests/qa-hierarchy/build.cjs
adb -s emulator-5556 install -r .tools/qa-hierarchy/Auralink-QA-hierarchy.apk
adb -s emulator-5556 shell am instrument -w local.auralink.qa/.HierarchyInstrumentation
adb -s emulator-5556 exec-out run-as local.auralink.qa cat files/hierarchy.xml
```

Set `JAVA_HOME` and `ANDROID_SDK_ROOT` if necessary. The builder also recognizes this project's ignored local `.tools` SDK/JDK folders. It signs only the QA APK with an ephemeral key and deletes the key afterward. A fresh emulator is used for each hosted runtime job; remove an older QA APK before installing one signed by another build.

The hierarchy is written to the QA package's private `files/hierarchy.xml`, replacing stale output atomically. The instrumentation command prints status and counts only. Raw XML can contain private invitations and must stay in ignored local diagnostics; never print it to CI logs or upload it. Only the separate QA APK is debuggable for `run-as`; Auralink stays non-debuggable. No storage or network permissions are requested.

References: [UiAutomation flags](https://developer.android.com/reference/android/app/UiAutomation#FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES), [Instrumentation.getUiAutomation](https://developer.android.com/reference/android/app/Instrumentation#getUiAutomation(int)).
