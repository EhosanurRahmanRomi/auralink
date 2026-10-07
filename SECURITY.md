# Security policy

Auralink is experimental. Only the current test release is maintained. Avoid sensitive production support until its security and device behavior have been independently reviewed.

Use the repository's **Security → Report a vulnerability** private reporting option when available. Otherwise open an issue requesting a private channel without publishing exploit details or personal information. No bounty or response-time guarantee is offered.

The application trusts its bundled interface and a privately exchanged invitation. Display names are not permanent verified identities. The host approves admission; device owners separately approve control. Invitations contain a secret and public certificate fingerprint. Native clients pin the valid leaf certificate before joining. WebRTC encrypts media and input transport.

Input consent binds a peer/session and active capture, with sequence/rate checks, expiry and local revocation. Android Accessibility alone grants nobody control. There is no unattended access service. OS secure surfaces remain protected.

No absolute-security or "virus-free" claim is made. Tests, signatures and scanners verify only their recorded boundaries. Keep OS, WebView and dependencies updated. Permanent identity, independent review and signed update delivery remain future work.
