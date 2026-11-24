# Security Policy

## Supported versions

Only the latest stable Ripple release line receives security fixes. The current
stable release is `v1.0.0`; update to the latest stable `1.0.x` release before
reporting an issue. Beta, release-candidate, development, and older release lines
are not supported for security updates.

| Version | Supported |
| --- | --- |
| Latest stable `1.0.x` (currently `v1.0.0`) | Yes |
| Prereleases (beta / RC) | No |
| Older versions and development builds | No |

## Reporting a vulnerability privately

Please **do not** report a security vulnerability in a public GitHub issue,
discussion, or pull request. Use GitHub's private vulnerability reporting for
this repository:

- [Report a vulnerability privately](https://github.com/iavaneeshmishra/Ripple-repo/security/advisories/new)
- Or open the repository's **Security** tab and choose **Report a vulnerability**.

Private vulnerability reporting is enabled. The report opens a confidential
advisory with the maintainers; it does not publish an advisory or create a public
issue. If the form is unavailable, contact the maintainer through the repository's
GitHub profile and ask for a private security-reporting channel without including
exploit details in the first public message.

Include, where possible:

- affected app version, platform, OS version, and release tag or commit;
- the security impact and conditions required to reproduce it;
- minimal reproduction steps or a proof of concept, plus any suggested mitigation.

Do not include real message contents, private keys, identity backups, or other
users' personal data. Use test identities and redact diagnostics to the minimum
needed to explain the issue.

## What to expect

We aim to acknowledge a report within **five business days** and provide an
initial assessment within **ten business days**. The private advisory thread is
the channel for questions and status updates; if you have not heard back after
five business days, send a follow-up there.

For a confirmed issue, maintainers will coordinate a fix, affected-version
assessment, and disclosure timing with the reporter. We will publish an advisory
and release a fix when it is safe to do so, and credit the reporter if they wish.
If a report is not considered a vulnerability or is out of scope, we will explain
the assessment in the private thread. Please do not disclose the issue publicly
until a coordinated disclosure date is agreed or a fix has been released.
