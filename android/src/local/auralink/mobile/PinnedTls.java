package local.auralink.mobile;

import java.security.MessageDigest;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/** Every connection checks the leaf pin, including otherwise CA-trusted replacements. */
public final class PinnedTls {
    public static void verifyCertificate(X509Certificate certificate, String pin) throws CertificateException {
        try {
            certificate.checkValidity();
            byte[] actual = MessageDigest.getInstance("SHA-256").digest(certificate.getEncoded());
            byte[] expected = new byte[32];
            if (pin == null || !pin.matches("[A-Fa-f0-9]{64}")) throw new CertificateException("Invalid certificate pin.");
            for (int i=0; i<32; i++) expected[i] = (byte)Integer.parseInt(pin.substring(i*2, i*2+2), 16);
            if (!MessageDigest.isEqual(actual, expected)) throw new CertificateException("Host certificate does not match the invitation.");
        } catch (CertificateException failure) { throw failure; }
        catch (Exception failure) { throw new CertificateException("Certificate verification failed.", failure); }
    }
    public static SSLContext context(final Invitation invitation) throws Exception {
        X509TrustManager trust = new X509TrustManager() {
            public void checkClientTrusted(X509Certificate[] chain, String type) throws CertificateException { throw new CertificateException("Client certificates are not accepted."); }
            public void checkServerTrusted(X509Certificate[] chain, String type) throws CertificateException {
                if (chain == null || chain.length == 0) throw new CertificateException("Missing host certificate.");
                verifyCertificate(chain[0], invitation.fingerprint);
            }
            public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
        };
        SSLContext context = SSLContext.getInstance("TLS");
        context.init(null, new TrustManager[]{trust}, new java.security.SecureRandom());
        return context;
    }
}
