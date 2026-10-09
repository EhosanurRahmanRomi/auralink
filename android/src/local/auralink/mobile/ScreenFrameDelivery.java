package local.auralink.mobile;

/** One owner-scoped pending frame; a paused consumer never grows a payload queue. */
final class ScreenFrameDelivery {
    private final String ticket;
    private long sequence, pending;
    private boolean closed;
    ScreenFrameDelivery(String ticket) {
        if (ticket == null || ticket.isEmpty()) throw new IllegalArgumentException("Missing screen capture ticket.");
        this.ticket = ticket;
    }
    synchronized boolean waiting() { return !closed && pending != 0; }
    synchronized long reserve() {
        if (closed || pending != 0 || sequence >= 9007199254740991L) return 0;
        pending = ++sequence; return pending;
    }
    synchronized boolean matches(long seq) { return !closed && seq > 0 && pending == seq; }
    synchronized boolean acknowledge(String owner, long seq) {
        if (owner == null || !ticket.equals(owner) || !matches(seq)) return false;
        pending = 0; return true;
    }
    synchronized void close() { closed = true; pending = 0; }
}
