package local.auralink.mobile;

import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Base64;
import android.view.WindowManager;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;

/** Owner-approved full-display projection. Frames stay in memory and are never recorded. */
public final class ScreenShareService extends Service {
    interface Listener {
        void started(int width, int height, int maxEdge);
        void frame(long sequence, String jpeg, int width, int height);
        void stopped(String reason);
    }
    static final String STOP = "local.auralink.mobile.STOP_SCREEN";
    private static final int NOTIFICATION = 1041;
    private static ScreenShareService instance;
    private static Listener pendingListener;
    private static String pendingTicket;
    private final Handler main = new Handler(Looper.getMainLooper());
    private HandlerThread captureThread;
    private Handler capture;
    private MediaProjection projection;
    private VirtualDisplay display;
    private ImageReader reader;
    private Bitmap padded;
    private byte[] pixels;
    private Listener listener;
    private volatile boolean running, fullDisplay, stopping;
    private volatile long inFlight, sentAt;
    private long sequence, lastFrame;
    private int width, height, contentWidth, contentHeight, maxEdge, foregroundTypes;
    private final DisplayManager.DisplayListener rotationListener = new DisplayManager.DisplayListener() {
        public void onDisplayAdded(int id) { }
        public void onDisplayRemoved(int id) { }
        public void onDisplayChanged(int id) {
            if (id == android.view.Display.DEFAULT_DISPLAY && Build.VERSION.SDK_INT < 34 && running) {
                Rect bounds = realBounds(); capture.post(() -> resize(bounds.width(), bounds.height()));
            }
        }
    };
    static synchronized void prepare(String ticket, Listener next) { pendingTicket = ticket; pendingListener = next; }
    static synchronized void cancelPreparation() { pendingTicket = null; pendingListener = null; }
    static boolean active() { return instance != null && instance.running && !instance.stopping; }
    static boolean activeFullDisplay() { return active() && instance.fullDisplay; }
    static void acknowledge(long seq) { ScreenShareService current = instance; if (current != null && current.inFlight == seq) current.inFlight = 0; }
    static void stopCurrent(String reason) { ScreenShareService current = instance; if (current != null) current.main.post(() -> current.stopSharing(reason)); else cancelPreparation(); }
    static void addMediaTypes(int types) { ScreenShareService current = instance; if (current != null && current.running) { current.foregroundTypes |= types; current.startForeground(NOTIFICATION, current.notification(), current.foregroundTypes); } }

    @Override public void onCreate() {
        super.onCreate(); instance = this;
        NotificationManager notifications = (NotificationManager)getSystemService(NOTIFICATION_SERVICE);
        notifications.createNotificationChannel(new NotificationChannel("screen-sharing", "Screen sharing and device control", NotificationManager.IMPORTANCE_LOW));
    }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || STOP.equals(intent.getAction())) { stopSharing("Stopped from the Android notification."); return START_NOT_STICKY; }
        if (stopping) {
            Listener waiting;
            synchronized (ScreenShareService.class) { waiting = pendingListener; cancelPreparation(); }
            if (waiting != null) waiting.stopped("Previous screen sharing is stopping. Try sharing again in a moment.");
            stopSelf(); return START_NOT_STICKY;
        }
        synchronized (ScreenShareService.class) {
            if (running || pendingListener == null || !java.util.Objects.equals(pendingTicket, intent.getStringExtra("ticket"))) { stopSelf(); return START_NOT_STICKY; }
            listener = pendingListener; pendingListener = null; pendingTicket = null;
        }
        maxEdge = intent.getIntExtra("maxEdge", 1280) == 1920 ? 1920 : 1280;
        foregroundTypes = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION;
        if (Build.VERSION.SDK_INT >= 30 && intent.getBooleanExtra("microphone", false) && checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) == android.content.pm.PackageManager.PERMISSION_GRANTED) foregroundTypes |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
        if (Build.VERSION.SDK_INT >= 30 && intent.getBooleanExtra("camera", false) && checkSelfPermission(android.Manifest.permission.CAMERA) == android.content.pm.PackageManager.PERMISSION_GRANTED) foregroundTypes |= ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA;
        try {
            // Foreground status must precede getMediaProjection on Android 14+.
            startForeground(NOTIFICATION, notification(), foregroundTypes);
            Intent consent = intent.getParcelableExtra("consent");
            if (consent == null) throw new IllegalStateException("Screen permission result is missing.");
            projection = ((MediaProjectionManager)getSystemService(MEDIA_PROJECTION_SERVICE)).getMediaProjection(Activity.RESULT_OK, consent);
            captureThread = new HandlerThread("Auralink screen capture"); captureThread.start(); capture = new Handler(captureThread.getLooper());
            projection.registerCallback(new MediaProjection.Callback() {
                @Override public void onStop() { main.post(() -> stopSharing("Android stopped screen sharing.")); }
                @Override public void onCapturedContentResize(int w, int h) { if (capture != null) capture.post(() -> resize(w, h)); }
            }, main);
            Rect bounds = realBounds(); contentWidth = bounds.width(); contentHeight = bounds.height(); configureReader(contentWidth, contentHeight);
            display = projection.createVirtualDisplay("Auralink attended screen", width, height, getResources().getConfiguration().densityDpi,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, reader.getSurface(), null, capture);
            running = true; fullDisplay = true;
            ((DisplayManager)getSystemService(DISPLAY_SERVICE)).registerDisplayListener(rotationListener, main);
            listener.started(width, height, maxEdge);
        } catch (Exception failure) { stopSharing("Screen capture could not start. Approve a new Android screen permission and retry."); }
        return START_NOT_STICKY;
    }
    private Rect realBounds() {
        WindowManager windows = (WindowManager)getSystemService(WINDOW_SERVICE);
        if (Build.VERSION.SDK_INT >= 30) return windows.getMaximumWindowMetrics().getBounds();
        android.util.DisplayMetrics metrics = new android.util.DisplayMetrics(); windows.getDefaultDisplay().getRealMetrics(metrics);
        return new Rect(0, 0, metrics.widthPixels, metrics.heightPixels);
    }
    private void configureReader(int w, int h) {
        if (w < 1 || h < 1 || w > 32768 || h > 32768) throw new IllegalArgumentException("Invalid screen dimensions.");
        float scale = Math.min(1f, maxEdge / (float)Math.max(w, h));
        width = Math.max(2, Math.round(w * scale) / 2 * 2); height = Math.max(2, Math.round(h * scale) / 2 * 2);
        reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2);
        reader.setOnImageAvailableListener(this::consumeFrame, capture);
    }
    private void resize(int w, int h) {
        if (!running || stopping || w < 1 || h < 1 || w > 32768 || h > 32768) return;
        Rect bounds = realBounds(); fullDisplay = Math.abs(bounds.width() - w) <= 2 && Math.abs(bounds.height() - h) <= 2;
        if (contentWidth == w && contentHeight == h) return;
        contentWidth = w; contentHeight = h;
        main.post(() -> { AttendedAccessibilityService service = AttendedAccessibilityService.current(); if (service != null) service.revoke("Screen dimensions changed. Approve control again."); });
        ImageReader previous = reader; Bitmap previousBitmap = padded; padded = null;
        try {
            configureReader(w, h); display.setSurface(null); display.resize(width, height, getResources().getConfiguration().densityDpi); display.setSurface(reader.getSurface());
        } catch (Exception failure) { main.post(() -> stopSharing("Screen changed; restart sharing to continue.")); }
        finally { if (previous != null) previous.close(); if (previousBitmap != null) previousBitmap.recycle(); }
    }
    private void consumeFrame(ImageReader source) {
        Image image = null; Bitmap visible = null;
        try {
            image = source.acquireLatestImage(); if (image == null || !running || stopping || source != reader) return;
            long now = SystemClock.elapsedRealtime();
            if (inFlight != 0 && now - sentAt > 3000) { main.post(() -> stopSharing("Screen delivery stalled. Return to Auralink and restart sharing.")); return; }
            if (inFlight != 0 || now - lastFrame < 83) return; // At most 12fps and one frame awaiting canvas acknowledgement.
            Image.Plane plane = image.getPlanes()[0]; int stride = plane.getRowStride(), pixelStride = plane.getPixelStride();
            if (pixelStride != 4 || stride < width * 4) return;
            int paddedWidth = stride / 4;
            if (padded == null || padded.getWidth() != paddedWidth || padded.getHeight() != height) { if (padded != null) padded.recycle(); padded = Bitmap.createBitmap(paddedWidth, height, Bitmap.Config.ARGB_8888); }
            ByteBuffer buffer = plane.getBuffer(); buffer.rewind();
            // The final image row may omit its padding; Bitmap requires a full rectangular buffer.
            int byteCount = stride * height;
            if (pixels == null || pixels.length != byteCount) pixels = new byte[byteCount];
            if (buffer.remaining() < stride * (height - 1) + width * 4) return;
            buffer.get(pixels, 0, Math.min(byteCount, buffer.remaining())); padded.copyPixelsFromBuffer(ByteBuffer.wrap(pixels));
            visible = Bitmap.createBitmap(padded, 0, 0, width, height);
            ByteArrayOutputStream bytes = new ByteArrayOutputStream(Math.min(width * height, 262144));
            visible.compress(Bitmap.CompressFormat.JPEG, 76, bytes);
            if (bytes.size() > 524288) { bytes.reset(); visible.compress(Bitmap.CompressFormat.JPEG, 52, bytes); }
            if (bytes.size() > 524288) return;
            final String encoded = Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP); final int frameWidth = width, frameHeight = height;
            final long seq = ++sequence; inFlight = seq; sentAt = lastFrame = now;
            main.post(() -> { if (running && !stopping && inFlight == seq && listener != null) listener.frame(seq, encoded, frameWidth, frameHeight); });
        } catch (Exception failure) { main.post(() -> stopSharing("Screen frame conversion failed. Restart sharing to continue.")); }
        finally { if (visible != null && visible != padded) visible.recycle(); if (image != null) image.close(); }
    }
    private Notification notification() {
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent stop = PendingIntent.getService(this, 1, new Intent(this, ScreenShareService.class).setAction(STOP), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, "screen-sharing").setSmallIcon(getApplicationInfo().icon)
            .setContentTitle("Auralink is sharing your screen").setContentText("Return to the app to manage consent. Stop ends sharing and control.")
            .setOngoing(true).setCategory(Notification.CATEGORY_SERVICE).setContentIntent(open).addAction(new Notification.Action.Builder(null, "Stop sharing", stop).build()).build();
    }
    private void stopSharing(String reason) {
        if (stopping) return; stopping = true; running = false; fullDisplay = false; inFlight = 0; cancelPreparation();
        AttendedAccessibilityService control = AttendedAccessibilityService.current(); if (control != null) control.revoke(reason);
        try { ((DisplayManager)getSystemService(DISPLAY_SERVICE)).unregisterDisplayListener(rotationListener); } catch (Exception ignored) { }
        MediaProjection previousProjection = projection; projection = null;
        Handler worker = capture;
        Runnable release = () -> {
            if (display != null) { display.release(); display = null; }
            if (reader != null) { reader.close(); reader = null; }
            if (padded != null) { padded.recycle(); padded = null; }
            pixels = null;
            if (previousProjection != null) previousProjection.stop();
            if (captureThread != null) captureThread.quitSafely();
        };
        if (worker != null) worker.post(release); else release.run();
        Listener previous = listener; listener = null; if (previous != null) previous.stopped(reason);
        stopForeground(STOP_FOREGROUND_REMOVE); stopSelf();
    }
    @Override public void onConfigurationChanged(Configuration next) {
        super.onConfigurationChanged(next);
        if (Build.VERSION.SDK_INT < 34 && running && capture != null) { Rect bounds = realBounds(); capture.post(() -> resize(bounds.width(), bounds.height())); }
    }
    @Override public void onDestroy() { stopSharing("Screen sharing service stopped."); if (instance == this) instance = null; super.onDestroy(); }
    @Override public IBinder onBind(Intent intent) { return null; }
}
