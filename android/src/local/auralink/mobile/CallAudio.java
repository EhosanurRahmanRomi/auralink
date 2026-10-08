package local.auralink.mobile;

import android.app.Activity;
import android.media.AudioAttributes;
import android.media.AudioDeviceInfo;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;

/** Owns only this call's focus and communication route; restores the previous mode. */
final class CallAudio {
    interface Listener { void unavailable(String reason); }
    private final Activity activity;
    private final AudioManager manager;
    private final AudioFocusRequest focus;
    private final Listener listener;
    private boolean active, focusOwned, speaker = true;
    private boolean previousSpeaker;
    private int previousMode, previousVolumeStream;
    private AudioDeviceInfo previousDevice;
    private String failure = "";
    CallAudio(Activity owner, Listener observer) {
        activity = owner; listener = observer; manager = (AudioManager)owner.getSystemService(Activity.AUDIO_SERVICE);
        focus = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
            .setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
            .setWillPauseWhenDucked(true).setOnAudioFocusChangeListener(change -> {
                if (!active) return;
                focusOwned = change == AudioManager.AUDIOFOCUS_GAIN;
                // Focus belongs to an audio player, not a capture permission.
                // WebView can also request focus for this same call. Do not
                // destroy its microphone merely because the owner changed.
                if (focusOwned) {
                    // OEM routing callbacks may throw independently of the
                    // original bridge request. Never crash the Activity here.
                    try {
                        manager.setMode(AudioManager.MODE_IN_COMMUNICATION);
                        if (!route()) fail("Android could not restore the call speaker. Return to Glance-Port and retry audio.");
                    } catch (RuntimeException denied) { fail("Android could not restore call audio. Return to Glance-Port and retry."); }
                }
            }).build();
    }
    String lastError() { return failure; }
    boolean update(boolean nextActive, boolean nextSpeaker) {
        speaker = nextSpeaker;
        if (!nextActive) { stop(); return true; }
        failure = "";
        try {
            if (!active || !focusOwned) {
                if (!active) {
                    previousMode = manager.getMode(); previousVolumeStream = activity.getVolumeControlStream();
                    previousSpeaker = manager.isSpeakerphoneOn();
                    previousDevice = Build.VERSION.SDK_INT >= 31 ? manager.getCommunicationDevice() : null;
                }
                if (manager.requestAudioFocus(focus) != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
                    failure = "Android audio focus is busy. Retry after the other call ends."; stop(); return false;
                }
                active = true; focusOwned = true;
            }
            manager.setMode(AudioManager.MODE_IN_COMMUNICATION);
            activity.setVolumeControlStream(AudioManager.STREAM_VOICE_CALL);
            if (!route()) { failure = "Android could not select the call speaker. Check the phone audio output and retry."; stop(); return false; }
            return true;
        } catch (RuntimeException denied) {
            failure = "Android could not activate call audio. Check the phone audio output and retry.";
            stop(); return false;
        }
    }
    boolean resume() {
        // Only reapply an already admitted call's route. Resuming an idle page
        // must neither request focus nor turn on a microphone.
        if (!active || !focusOwned) return true;
        return update(true, speaker);
    }
    private boolean route() {
        if (Build.VERSION.SDK_INT >= 31) {
            int desired = speaker ? AudioDeviceInfo.TYPE_BUILTIN_SPEAKER : AudioDeviceInfo.TYPE_BUILTIN_EARPIECE;
            for (AudioDeviceInfo device : manager.getAvailableCommunicationDevices()) {
                if (device.getType() == desired) return manager.setCommunicationDevice(device);
            }
            // Tablets can have no earpiece. Their normal selected route remains
            // available, while an absent requested speaker is reported.
            if (!speaker) { manager.clearCommunicationDevice(); return true; }
            return false;
        }
        manager.setSpeakerphoneOn(speaker); return manager.isSpeakerphoneOn() == speaker;
    }
    private void fail(String reason) {
        failure = reason; stop(); if (listener != null) listener.unavailable(reason);
    }
    void stop() {
        if (!active) return;
        active = false; focusOwned = false;
        // A failure while restoring one setting must not leave focus owned or
        // prevent the other settings from being released.
        try {
            if (Build.VERSION.SDK_INT >= 31) {
                if (previousDevice == null || !manager.setCommunicationDevice(previousDevice)) manager.clearCommunicationDevice();
            } else manager.setSpeakerphoneOn(previousSpeaker);
        } catch (RuntimeException ignored) { }
        try { manager.abandonAudioFocusRequest(focus); } catch (RuntimeException ignored) { }
        try { if (manager.getMode() == AudioManager.MODE_IN_COMMUNICATION) manager.setMode(previousMode); } catch (RuntimeException ignored) { }
        activity.setVolumeControlStream(previousVolumeStream); previousDevice = null;
    }
}
