package local.auralink.mobile;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioPlaybackCaptureConfiguration;
import android.media.AudioRecord;
import android.media.projection.MediaProjection;
import android.os.Handler;
import android.os.Looper;
import android.os.Process;
import android.util.Base64;
import java.util.concurrent.atomic.AtomicLong;

/** Capture permitted media/game playback with the existing screen consent.
 * No microphone source, file recording, voice-call usage or own-app feedback. */
final class PlaybackAudio {
    interface Listener { void chunk(long sequence, String data, int frames); void stopped(String reason); }
    static final int SAMPLE_RATE = 48000, CHANNELS = 2, FRAMES = 1920;
    private static final AtomicLong SEQUENCE = new AtomicLong();
    private final AudioRecord recorder;
    private final Listener listener;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final AtomicLong awaitingAcknowledgement = new AtomicLong();
    private volatile boolean active;
    private Thread worker;

    PlaybackAudio(Context context, MediaProjection projection, Listener callback) {
        if (projection == null || callback == null) throw new IllegalArgumentException("Screen sharing is required for device audio.");
        listener = callback;
        AudioPlaybackCaptureConfiguration capture = new AudioPlaybackCaptureConfiguration.Builder(projection)
            .addMatchingUsage(AudioAttributes.USAGE_MEDIA).addMatchingUsage(AudioAttributes.USAGE_GAME)
            .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN).excludeUid(Process.myUid()).build();
        int minimum = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_STEREO, AudioFormat.ENCODING_PCM_16BIT);
        if (minimum <= 0) throw new IllegalStateException("This phone does not support 48 kHz stereo playback capture.");
        recorder = new AudioRecord.Builder().setAudioPlaybackCaptureConfig(capture)
            .setAudioFormat(new AudioFormat.Builder().setSampleRate(SAMPLE_RATE)
                .setChannelMask(AudioFormat.CHANNEL_IN_STEREO).setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
            .setBufferSizeInBytes(Math.max(minimum, FRAMES * CHANNELS * 2 * 3)).build();
        if (recorder.getState() != AudioRecord.STATE_INITIALIZED) { recorder.release(); throw new IllegalStateException("Android could not initialize device audio capture."); }
    }
    void start() {
        if (active || worker != null) throw new IllegalStateException("Device audio is already active.");
        try { recorder.startRecording(); }
        catch (RuntimeException failure) { recorder.release(); throw failure; }
        if (recorder.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) { recorder.release(); throw new IllegalStateException("Android did not start playback capture."); }
        active = true; worker = new Thread(this::read, "Glance-Port device audio"); worker.start();
    }
    private void read() {
        Process.setThreadPriority(Process.THREAD_PRIORITY_AUDIO);
        byte[] bytes = new byte[FRAMES * CHANNELS * 2]; int offset = 0;
        String failure = null;
        try {
            while (active) {
                int count = recorder.read(bytes, offset, bytes.length - offset, AudioRecord.READ_BLOCKING);
                if (!active) break;
                if (count < 0) throw new IllegalStateException("Android stopped device audio capture.");
                if (count == 0) continue;
                offset += count;
                if (offset < bytes.length) continue;
                offset = 0;
                // A background WebView never creates an unbounded PCM backlog.
                if (awaitingAcknowledgement.get() != 0) continue;
                final long seq = SEQUENCE.incrementAndGet();
                if (!awaitingAcknowledgement.compareAndSet(0, seq)) continue;
                final String encoded = Base64.encodeToString(bytes, Base64.NO_WRAP);
                main.post(() -> { if (active && awaitingAcknowledgement.get() == seq) listener.chunk(seq, encoded, FRAMES); });
            }
        } catch (RuntimeException ended) { if (active) failure = "Device audio stopped. Enable it again after checking Android audio permission."; }
        finally {
            boolean notify = active && failure != null; active = false;
            try { recorder.stop(); } catch (RuntimeException ignored) { }
            recorder.release();
            if (notify) { final String reason = failure; main.post(() -> listener.stopped(reason)); }
        }
    }
    void stop() {
        active = false; awaitingAcknowledgement.set(0);
        try { recorder.stop(); } catch (RuntimeException ignored) { }
        // read() owns release; stop() unblocks its bounded native read.
    }
    void acknowledge(long sequence) { if (sequence > 0) awaitingAcknowledgement.compareAndSet(sequence, 0); }
}
