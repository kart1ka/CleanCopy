# Security policy

## Supported versions

The latest minor release line receives security fixes.

## Report a vulnerability privately

Please do not open a public issue for a suspected vulnerability. Use a
[private GitHub security advisory](https://github.com/kart1ka/CleanCopy/security/advisories/new)
and include:

- the CleanCopy, macOS, and Node.js versions;
- the security impact and the conditions needed to reproduce it;
- minimal reproduction steps or a proof of concept; and
- any suggested mitigation, if you have one.

Reports involving unintended clipboard disclosure, clipboard contents written
to disk or sent over the network, unsafe process signalling, launch-agent
privilege or path handling, native-helper message validation, or npm release
integrity are especially important.

You can expect a best-effort acknowledgement and an update after the report has
been reproduced. Please allow time for a coordinated fix before disclosure.

## Privacy boundary

CleanCopy processes clipboard text locally. It must never log clipboard
contents, send them over the network, or read pasteboard items marked concealed
or transient. Event logs contain only content-free summaries. A security report
should avoid including real passwords, tokens, or private clipboard data; use a
synthetic reproduction instead.
