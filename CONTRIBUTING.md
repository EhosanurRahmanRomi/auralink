# Contributing

Use Node.js 24 and `npm ci`. Make a focused branch and run `npm test` and `npm run check`. Media changes should also run browser/WebRTC tests; platform changes need the relevant build and endpoint test. Distinguish synthetic tests from hardware checks.

Report the release version, endpoint OS/WebView versions, network arrangement, consent steps, expected behavior and actual behavior. Remove private invitations and room keys from screenshots/logs.

Preserve separate owner consent, admission, local stop, short-lived scoped input, pinned certificates and trusted-page IPC. Do not add unattended grants, secret capture, arbitrary command bridges or global TLS bypasses.

Pull requests should describe the problem, resulting behavior, verification and practical limits. Vulnerabilities should follow [SECURITY.md](SECURITY.md).
