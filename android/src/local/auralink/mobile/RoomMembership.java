package local.auralink.mobile;

import java.util.HashSet;
import java.util.Set;

/** Native admission state populated only from authenticated socket messages. */
public final class RoomMembership {
    private String self;
    private long epoch;
    private boolean expectingAdmission;
    private String expectedRoom, expectedSelf;
    private final Set<String> peers = new HashSet<>();
    public boolean begin(String identity, Iterable<String> admitted) {
        clear();
        if (!AttendedControlPolicy.validIdentity(identity)) return false;
        Set<String> next = new HashSet<>();
        for (String peer : admitted) {
            if (!AttendedControlPolicy.validIdentity(peer) || identity.equals(peer) || !next.add(peer) || next.size() > 31) return false;
        }
        self = identity; peers.addAll(next); return true;
    }
    public boolean add(String peer) {
        return self != null && AttendedControlPolicy.validIdentity(peer) && !self.equals(peer) && peers.size() < 31 && peers.add(peer);
    }
    public void remove(String peer) { peers.remove(peer); }
    public boolean allows(String peer) { return self != null && peers.contains(peer); }
    public boolean hasRoom() { return self != null; }
    public String selfId() { return self; }
    public long epoch() { return epoch; }
    public boolean expectAdmission(String room, boolean viaDevice) {
        clear();
        if (!viaDevice && !AttendedControlPolicy.validIdentity(room)) return false;
        expectingAdmission = true; expectedRoom = viaDevice ? null : room; return true;
    }
    public boolean observePending(String identity, String room) {
        if (!expectingAdmission || !AttendedControlPolicy.validIdentity(identity) || !AttendedControlPolicy.validIdentity(room) ||
            (expectedRoom != null && !expectedRoom.equals(room)) || (expectedSelf != null && !expectedSelf.equals(identity))) return false;
        expectedSelf = identity; expectedRoom = room; return true;
    }
    public boolean acceptsWelcome(String identity, String room) {
        return expectingAdmission && AttendedControlPolicy.validIdentity(identity) && AttendedControlPolicy.validIdentity(room) &&
            (expectedSelf == null || expectedSelf.equals(identity)) && (expectedRoom == null || expectedRoom.equals(room));
    }
    public boolean endForEvent(String type) {
        if (!("room-left".equals(type) || "room-ended".equals(type) || "rejected".equals(type))) return false;
        clear(); return true;
    }
    public boolean endForOutbound(String type) {
        if (!("leave".equals(type) || "join".equals(type) || "join-device".equals(type) || "create-room".equals(type) || "forget".equals(type))) return false;
        clear(); return true;
    }
    public void clear() { epoch++; self = null; peers.clear(); expectingAdmission = false; expectedRoom = null; expectedSelf = null; }
}
