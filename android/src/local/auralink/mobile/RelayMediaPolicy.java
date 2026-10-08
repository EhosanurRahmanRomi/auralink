package local.auralink.mobile;

import java.util.Base64;

/** Only bounded encrypted media may use the larger Internet socket frame limit. */
public final class RelayMediaPolicy {
    public static final int SIGNAL_LIMIT = 65536, WIRE_LIMIT = 262144, BRIDGE_LIMIT = 300000;
    private RelayMediaPolicy() { }
    public static boolean validKey(String key) { return canonical(key, 32, 32); }
    public static boolean valid(int fields, double version, String epoch, double counter, String nonce, String ciphertext) {
        if (fields != 5 || version != 1 || !Double.isFinite(counter) || counter < 1 || counter > 9007199254740991d || counter != Math.floor(counter) ||
            !canonical(epoch, 12, 12) || !canonical(nonce, 12, 12)) return false;
        return canonical(ciphertext, 16, 180000);
    }
    private static boolean canonical(String value, int minimum, int maximum) {
        if (value == null || value.length() < (minimum * 4 + 2) / 3 || value.length() > (maximum * 4 + 2) / 3 || !value.matches("[A-Za-z0-9_-]+")) return false;
        try {
            byte[] bytes = Base64.getUrlDecoder().decode(value);
            return bytes.length >= minimum && bytes.length <= maximum && Base64.getUrlEncoder().withoutPadding().encodeToString(bytes).equals(value);
        } catch (IllegalArgumentException invalid) { return false; }
    }
}
