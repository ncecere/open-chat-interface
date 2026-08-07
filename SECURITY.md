# Security policy

## Supported versions

Until the project reaches 1.0, security fixes are provided for the latest minor
release only.

| Version | Supported |
|---|---|
| 0.1.x | Yes |
| Earlier versions | No |

## Reporting a vulnerability

Do not disclose suspected vulnerabilities in public issues, merge requests, or
chat channels.

Report them through a **confidential issue** in the
[Open Chat Interface GitLab project](https://gitlab.it.ufl.edu/ict/aipe/software/open-chat-interface/-/issues/new).
Select **This issue is confidential** before submitting. Include:

- the affected version or commit;
- the deployment conditions required to reproduce it;
- clear reproduction steps or a proof of concept;
- the likely impact; and
- any suggested mitigation, if known.

If you cannot access the project or create a confidential issue, contact the
project maintainers through the UF AIPE support channel and ask for a private
security-reporting path. Do not send credentials, API keys, session cookies, or
production data in the initial message.

Maintainers will acknowledge a complete report, assess severity and affected
versions, coordinate a fix, and credit the reporter unless anonymity is
requested. Public disclosure should wait until a fixed release is available and
deployers have had reasonable time to update.

## Deployment responsibility

OCI stores authentication data, conversations, attachments, and encrypted
provider credentials. Operators are responsible for TLS termination, secret
management, database and object-storage backups, network controls, timely
updates, and restricting administrator access.
