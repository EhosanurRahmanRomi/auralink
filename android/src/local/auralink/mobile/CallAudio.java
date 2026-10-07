package local.auralink.mobile;

import android.app.Activity;
import android.media.AudioAttributes;
import android.media.AudioDeviceInfo;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;

/** Owns only this call's focus and communication route; restores the previous mode. */
final class CallAudio {
    private final Activity activity;
    private final AudioManager manager;
    private final AudioFocusRequest focus;
    private boolean active, focusOwned, speaker = true;
    private int previousMode;
    CallAudio(Activity owner) {
        activity = owner; manager = (AudioManager)owner.getSystemService(Activity.AUDIO_SERVICE);
        focus = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
            .setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
            .setWillPauseWhenDucked(true).setOnAudioFocusChangeListener(change -> {
                focusOwned = change == AudioManager.AUDIOFOCUS_GAIN;
                if (active && focusOwned) {
                    if (manager.getMode() == AudioManager.MODE_NORMAL) manager.setMode(AudioManager.MODE_IN_COMMUNICATION);
                    route();
                }
            }).build();
    }
    boolean update(boolean nextActive, boolean nextSpeaker) {
        speaker = nextSpeaker;
        if (!nextActive) { stop(); return true; }
        if (!active || !focusOwned) {
            if (!active) previousMode = manager.getMode();
            if (manager.requestAudioFocus(focus) != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) return false;
            active = true; focusOwned = true;
        }
        manager.setMode(AudioManager.MODE_IN_COMMUNICATION);
        activity.setVolumeControlStream(AudioManager.STREAM_VOICE_CALL);
        route(); return true;
    }
    private void route() {
        if (Build.VERSION.SDK_INT >= 31) {
            if (!speaker) { manager.clearCommunicationDevice(); return; }
            for (AudioDeviceInfo device : manager.getAvailableCommunicationDevices()) {
                if (device.getType() == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) { manager.setCommunicationDevice(device); return; }
            }
        } else manager.setSpeakerphoneOn(speaker);
    }
    void stop() {
        if (!active) return;
        active = false; focusOwned = false;
        if (Build.VERSION.SDK_INT >= 31) manager.clearCommunicationDevice(); else manager.setSpeakerphoneOn(false);
        manager.abandonAudioFocusRequest(focus);
        if (manager.getMode() == AudioManager.MODE_IN_COMMUNICATION) manager.setMode(previousMode);
        activity.setVolumeControlStream(AudioManager.STREAM_MUSIC);
    }
}
