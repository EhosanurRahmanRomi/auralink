package local.auralink.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.Handler;
import android.os.Looper;

/** Keeps an explicitly opened remote-device room visible; never restarts a session. */
public final class CallSessionService extends Service {
    interface Listener { void started(); void stopped(String reason); }
    private static final String STOP = "local.auralink.mobile.STOP_CALL";
    private static final int NOTIFICATION = 1042;
    private static final ProjectionOwnership ownership = new ProjectionOwnership();
    private static CallSessionService instance;
    private static Listener pendingListener;
    private String ticket;
    private Listener listener;
    private int types;
    private boolean running, stopping;
    private PowerManager.WakeLock roomWakeLock;
    private final Handler main = new Handler(Looper.getMainLooper());
    private static final long WAKE_LEASE_MS = 5L * 60 * 1000;
    private final Runnable renewRoomWakeLock = new Runnable() {
        @Override public void run() {
            if (!running || stopping || !ownership.activeMatches(ticket)) return;
            try {
                if (roomWakeLock != null) roomWakeLock.acquire(WAKE_LEASE_MS);
                main.postDelayed(this, WAKE_LEASE_MS / 2);
            } catch (RuntimeException denied) { end("Android could not keep the active room awake. Reopen Glance-Port to reconnect."); }
        }
    };

    static synchronized void prepare(String id, Listener next) { ownership.prepare(id); pendingListener = next; }
    static synchronized void cancelPreparation(String id) { if (ownership.cancelPending(id)) pendingListener = null; }
    static boolean active(String id) { return instance != null && instance.running && !instance.stopping && id != null && id.equals(instance.ticket); }
    static boolean addMediaTypes(String id, int required) {
        CallSessionService current = instance;
        if (!active(id)) return false;
        int previous = current.types;
        try {
            int next = current.types | required;
            if (next != current.types) { current.types = next; current.startForeground(NOTIFICATION, current.notification(), next); }
            return true;
        } catch (RuntimeException denied) { current.types = previous; return false; }
    }
    static void stop(String id, String reason) {
        cancelPreparation(id);
        CallSessionService current = instance;
        if (current != null && id != null && id.equals(current.ticket)) current.end(reason);
    }
    @Override public void onCreate() {
        super.onCreate(); instance = this;
        ((NotificationManager)getSystemService(NOTIFICATION_SERVICE)).createNotificationChannel(
            new NotificationChannel("active-call", "Open rooms and calls", NotificationManager.IMPORTANCE_LOW));
    }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) { if (!running) stopSelfResult(startId); return START_NOT_STICKY; }
        String id = intent.getStringExtra("ticket");
        if (STOP.equals(intent.getAction())) { if (id != null && id.equals(ticket)) end("Call ended from Android notification."); return START_NOT_STICKY; }
        // Delayed or duplicate intents cannot replace another conversation.
        if (running) return START_NOT_STICKY;
        if (stopping) {
            Listener waiting;
            synchronized (CallSessionService.class) {
                waiting = ownership.pendingMatches(id) ? pendingListener : null;
                cancelPreparation(id);
            }
            if (waiting != null) waiting.stopped("Previous session is still stopping. Return to Glance-Port and reconnect.");
            stopSelfResult(startId); return START_NOT_STICKY;
        }
        synchronized (CallSessionService.class) {
            if (pendingListener == null || !ownership.claim(id)) {
                if (pendingListener == null) stopSelfResult(startId);
                return START_NOT_STICKY;
            }
            ticket = id; listener = pendingListener; pendingListener = null;
        }
        types = intent.getIntExtra("types", ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
        try {
            startForeground(NOTIFICATION, notification(), types);
            // Keep the admitted connection's CPU available during ordinary app
            // switches. Never hold a lock for an idle page or restart a room.
            roomWakeLock = ((PowerManager)getSystemService(POWER_SERVICE)).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, getPackageName() + ":active-room");
            roomWakeLock.setReferenceCounted(false);
            running = true; renewRoomWakeLock.run(); if (running && listener != null) listener.started();
        }
        catch (RuntimeException denied) { end("Android could not keep this call active. Return to Glance-Port and reconnect."); }
        return START_NOT_STICKY;
    }
    private Notification notification() {
        PendingIntent open = PendingIntent.getActivity(this, 1042, new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent stop = PendingIntent.getService(this, 1042, new Intent(this, CallSessionService.class).setAction(STOP).putExtra("ticket", ticket), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        boolean media = (types & (ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK | ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)) != 0;
        return new Notification.Builder(this, "active-call").setSmallIcon(getApplicationInfo().icon)
            .setContentTitle(media ? "Glance-Port call in progress" : "Glance-Port room is open").setContentText("Return to your room or end the session here.")
            .setOngoing(true).setCategory(media ? Notification.CATEGORY_CALL : Notification.CATEGORY_SERVICE).setContentIntent(open)
            .addAction(new Notification.Action.Builder(null, media ? "End call" : "End session", stop).build()).build();
    }
    private void end(String reason) {
        if (stopping) return; stopping = true; running = false;
        main.removeCallbacks(renewRoomWakeLock);
        if (roomWakeLock != null) { if (roomWakeLock.isHeld()) roomWakeLock.release(); roomWakeLock = null; }
        cancelPreparation(ticket); ownership.release(ticket);
        Listener previous = listener; listener = null;
        stopForeground(STOP_FOREGROUND_REMOVE); stopSelf();
        if (previous != null) previous.stopped(reason);
    }
    @Override public void onTaskRemoved(Intent rootIntent) { end("Call ended because Glance-Port was closed."); super.onTaskRemoved(rootIntent); }
    @Override public void onDestroy() { end("Android stopped the active call service."); if (instance == this) instance = null; super.onDestroy(); }
    @Override public IBinder onBind(Intent intent) { return null; }
}
