# Security policy

## Supported versions

Until the project reaches 1.0, security fixes are provided for the latest minor
release only.

| Version | Supported |
|---|---|
| 0.10.x | Yes |
| Earlier versions | No |

## Reporting a vulnerability

Do not disclose suspected vulnerabilities in public issues, pull requests, or
chat channels. Ordinary GitHub issues are not confidential security reports.

Use **Report a vulnerability** in the
[GitHub repository's Security tab](https://github.com/ncecere/open-chat-interface/security)
(private vulnerability reporting). If it is unavailable to you, contact the
maintainer through an established private channel and ask for a secure
reporting path before sharing details. Include in the private report:

- the affected version or commit;
- the deployment conditions required to reproduce it;
- clear reproduction steps or a proof of concept;
- the likely impact; and
- any suggested mitigation, if known.

Do not send credentials, API keys, session cookies, or production data in the
initial message. Do not fall back to a public issue if private reporting is
unavailable.

Maintainers will acknowledge a complete report, assess severity and affected
versions, coordinate a fix, and credit the reporter unless anonymity is
requested. Public disclosure should wait until a fixed release is available and
deployers have had reasonable time to update.

## Deployment responsibility

OCI stores authentication data, conversations, attachments, and encrypted
provider credentials. Operators are responsible for TLS termination, secret
management, database and object-storage backups, network controls, timely
updates, and restricting administrator access.
