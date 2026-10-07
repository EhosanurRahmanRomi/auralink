package local.auralink.mobile;

/** Tickets bind delayed Android service intents and teardown to their owner consent. */
public final class ProjectionOwnership {
    private String pending, active;
    public synchronized void prepare(String ticket) {
        if (ticket == null || ticket.isEmpty()) throw new IllegalArgumentException("Missing projection ticket.");
        pending = ticket;
    }
    public synchronized boolean pendingMatches(String ticket) { return ticket != null && ticket.equals(pending); }
    public synchronized boolean claim(String ticket) {
        if (active != null || !pendingMatches(ticket)) return false;
        active = pending; pending = null; return true;
    }
    public synchronized boolean activeMatches(String ticket) { return ticket != null && ticket.equals(active); }
    public synchronized boolean cancelPending(String ticket) {
        if (!pendingMatches(ticket)) return false;
        pending = null; return true;
    }
    public synchronized boolean release(String ticket) {
        if (!activeMatches(ticket)) return false;
        active = null; cancelPending(ticket); return true;
    }
    public synchronized void clearPending() { pending = null; }
}
