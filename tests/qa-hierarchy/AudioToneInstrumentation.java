package local.auralink.qa;

import android.app.Activity;
import android.app.Instrumentation;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioTrack;
import android.os.Bundle;
import android.os.SystemClock;

/** Finite owner-invoked playback from a different app UID. No recording,
 * network, files, accessibility automation or production bridge is used. */
public final class AudioToneInstrumentation extends Instrumentation {
    private static final int SAMPLE_RATE = 48000, CHANNELS = 2;
    private static final int FRAMES = SAMPLE_RATE * 4;

    @Override public void onCreate(Bundle arguments) { super.onCreate(arguments); start(); }

    @Override public void onStart() {
        Bundle result = new Bundle(); AudioTrack track = null; int resultCode = Activity.RESULT_CANCELED;
        try {
            AudioAttributes attributes = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                .setAllowedCapturePolicy(AudioAttributes.ALLOW_CAPTURE_BY_ALL).build();
            byte[] pcm = new byte[FRAMES * CHANNELS * 2];
            // Distinct left/right frequencies make stereo delivery measurable.
            // A short fade avoids a playback-start click; level stays -14 dBFS.
            for (int frame = 0; frame < FRAMES; frame++) {
                double edge = Math.min(1d, Math.min(frame, FRAMES - 1 - frame) / 960d);
                for (int channel = 0; channel < CHANNELS; channel++) {
                    double frequency = channel == 0 ? 440d : 660d;
                    short sample = (short)Math.round(Math.sin(2d * Math.PI * frequency * frame / SAMPLE_RATE) * 6553d * edge);
                    int offset = (frame * CHANNELS + channel) * 2;
                    pcm[offset] = (byte)sample; pcm[offset + 1] = (byte)(sample >>> 8);
                }
            }
            track = new AudioTrack.Builder().setAudioAttributes(attributes)
                .setAudioFormat(new AudioFormat.Builder().setSampleRate(SAMPLE_RATE)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_STEREO).setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
                .setTransferMode(AudioTrack.MODE_STATIC).setBufferSizeInBytes(pcm.length).build();
            // A static AudioTrack is STATE_NO_STATIC_DATA until the first
            // buffer write; that documented state is not initialization loss.
            if (track.getState() == AudioTrack.STATE_UNINITIALIZED || track.getSampleRate() != SAMPLE_RATE || track.getChannelCount() != CHANNELS)
                throw new IllegalStateException("Stereo fixture could not initialize.");
            if (track.write(pcm, 0, pcm.length) != pcm.length) throw new IllegalStateException("Stereo fixture could not load its finite buffer.");
            if (track.getState() != AudioTrack.STATE_INITIALIZED) throw new IllegalStateException("Stereo fixture did not become ready after loading.");
            long started = SystemClock.elapsedRealtime(); track.play();
            if (track.getPlayState() != AudioTrack.PLAYSTATE_PLAYING) throw new IllegalStateException("Stereo fixture did not start playing.");
            long deadline = started + 6000;
            while (track.getPlaybackHeadPosition() < FRAMES && SystemClock.elapsedRealtime() < deadline) SystemClock.sleep(20);
            int played = track.getPlaybackHeadPosition(); long elapsed = SystemClock.elapsedRealtime() - started;
            if (played < FRAMES || elapsed < 3000 || elapsed > 6000) throw new IllegalStateException("Stereo fixture did not finish its bounded playback.");
            result.putString("tone_passed", "true");
            result.putInt("tone_sample_rate", SAMPLE_RATE); result.putInt("tone_channels", CHANNELS);
            result.putInt("tone_frames", FRAMES); result.putInt("tone_played_frames", played);
            result.putLong("tone_elapsed_ms", elapsed); result.putString("tone_frequencies_hz", "440,660");
            result.putString("tone_capture_policy", "allow_capture_by_all"); result.putString("tone_usage", "media");
            result.putString("tone_package", getTargetContext().getPackageName());
            result.putInt("tone_uid", getTargetContext().getApplicationInfo().uid);
            result.putString("tone_boundary", "Synthetic external-app playback; no physical microphone or speaker proof");
            resultCode = Activity.RESULT_OK;
        } catch (Throwable failure) {
            // Report only a fixed fixture error class, never platform data.
            result.putString("tone_passed", "false"); result.putString("tone_error", failure.getClass().getSimpleName());
        } finally {
            if (track != null) {
                try { track.stop(); } catch (RuntimeException ignored) { }
                try { track.release(); } catch (RuntimeException ignored) { }
            }
        }
        // Cleanup completes before the instrumentation process is finished.
        finish(resultCode, result);
    }
}
