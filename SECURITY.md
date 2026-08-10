# Security policy

## Supported versions

Security fixes are applied to the current `master` branch. Until the project publishes versioned releases, older commits are not supported.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use the repository's private **Report a vulnerability** flow under GitHub Security Advisories. Include the affected commit, reproduction steps, impact, and any suggested mitigation. Do not include real provider credentials or user data.

Maintainers should acknowledge a complete report within seven days, coordinate remediation privately, and publish an advisory after a fix is available. Reporters acting in good faith should avoid privacy violations, service disruption, persistence, or accessing data beyond the minimum needed to demonstrate the issue.

## Security boundaries

- Provider and Puter credentials are secrets. Never paste them into issues, logs, fixtures, screenshots, or commits.
- `.env`, `.harness/`, workspace data, databases, backups, and logs must remain untracked.
- Account deletion removes live database rows and the managed workspace. Existing encrypted backups remain under the operator's retention policy until they expire; operators must disclose that policy to users and protect backup access.
- Production code execution is intentionally disabled. A future execution feature must use a separate disposable sandbox with a minimal environment and restricted network/filesystem access.
- `HARNESS_FREE_ONLY` and local usage ceilings are safety controls, not provider billing guarantees. Upstream account spending controls remain authoritative.
- Public deployments must use HTTPS through the documented reverse proxy and must not publish the application container port directly.

See [deploy/OPERATIONS.md](./deploy/OPERATIONS.md) for deployment and incident-response guidance.
