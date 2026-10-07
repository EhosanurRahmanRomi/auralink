const {X509Certificate} = require('node:crypto');
function normalizeFingerprint(value) { return String(value || '').replace(/:/g, '').toLowerCase(); }
function fingerprint(cert) { return normalizeFingerprint(new X509Certificate(cert).fingerprint256); }
function certificateDecisionForPin(expected, certificate, verificationResult) {
  if (expected) {
    try {return fingerprint(certificate) === expected ? 0 : -2;} catch {return -2;}
  }
  return verificationResult === 'net::OK' ? -3 : -2;
}
function parseInvite(value) {
  if (typeof value !== 'string' || value.length > 4096) throw new Error('Paste a valid Auralink invitation.');
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error('The invitation must be a complete HTTPS link.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search) throw new Error('Only HTTPS room invitations are accepted.');
  const params = new URLSearchParams(url.hash.slice(1));
  const roomKey = params.get('key');
  const fp = normalizeFingerprint(params.get('fp'));
  if (!roomKey || !/^[A-Za-z0-9_-]{32,128}$/.test(roomKey) || !/^[a-f0-9]{64}$/.test(fp)) throw new Error('Invitation is missing its secure room key or certificate fingerprint.');
  return {url:url.origin, roomKey, fingerprint:fp};
}
module.exports = {parseInvite, normalizeFingerprint, fingerprint, certificateDecisionForPin};
