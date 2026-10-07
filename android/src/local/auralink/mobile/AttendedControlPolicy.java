package local.auralink.mobile;

/** Android-independent authorization boundary, also exercised by the JVM harness. */
public final class AttendedControlPolicy {
    public static final long DURATION_MS = 15 * 60 * 1000L;
    private String peer, session;
    private long expires, sequence, lastTick;
    private double tokens;
    private boolean confirmed;
    public static boolean validIdentity(String value) {
        return value != null && value.length() >= 1 && value.length() <= 128 && value.matches("[A-Za-z0-9_-]+");
    }
    public static boolean validSequence(Object value) {
        if (!(value instanceof Number)) return false;
        double number = ((Number)value).doubleValue();
        return !Double.isNaN(number) && !Double.isInfinite(number) && number >= 1 && number <= 9007199254740991d && number == Math.floor(number);
    }
    public synchronized boolean grant(String peerId, String sessionId, long now) {
        revoke();
        if (!validIdentity(peerId) || !validIdentity(sessionId) || sessionId.length() < 16 || now < 0 || now > Long.MAX_VALUE - DURATION_MS) return false;
        peer = peerId; session = sessionId; expires = now + DURATION_MS; lastTick = now; tokens = 300; return true;
    }
    public synchronized boolean confirm(String peerId, String sessionId) {
        if (!matches(peerId, sessionId)) return false;
        confirmed = true; return true;
    }
    public synchronized boolean matches(String peerId, String sessionId) {
        return peer != null && peer.equals(peerId) && session.equals(sessionId);
    }
    public synchronized boolean active(long now) { return peer != null && now < expires; }
    public synchronized boolean confirmed() { return confirmed; }
    public synchronized boolean accepts(String peerId, String sessionId, long seq, String type, long now) {
        if (!matches(peerId, sessionId) || !confirmed || now < 0 || now >= expires || seq < 1 || seq <= sequence) return false;
        if (!("move".equals(type) || "down".equals(type) || "up".equals(type) || "wheel".equals(type) || "keydown".equals(type) || "keyup".equals(type))) return false;
        tokens = Math.min(300, tokens + Math.max(0, now - lastTick) * 0.3); lastTick = now;
        if (tokens < 1 && !"up".equals(type) && !"keyup".equals(type)) return false;
        tokens = Math.max(0, tokens - 1); sequence = seq; return true;
    }
    public synchronized String peerId() { return peer; }
    public synchronized String sessionId() { return session; }
    public synchronized void revoke() { peer = null; session = null; expires = 0; sequence = 0; confirmed = false; tokens = 0; }
}
