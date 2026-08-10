# Privacy notice

Free AI Harness is self-hosted software. The operator of each deployed instance is the data controller for that instance; the open-source contributors do not receive instance data merely because the software is used.

## Data processed by an instance

An instance may store:

- an opaque identifier and display name returned by Puter;
- the encrypted Puter or provider credential needed to make authorized requests;
- session hashes, workflow prompts, model responses, tool events, feedback, and usage measurements;
- files deliberately created in the user's isolated managed workspace;
- operational metadata such as request IDs, status codes, latency, and timestamps.

Raw session cookies and plaintext provider credentials are not stored in application logs. Credentials are encrypted at rest with the instance's vault key. Prompts and outputs are sent to Puter or the automatically selected provider to fulfill the user's request and are then governed by that provider's terms and privacy practices.

## Retention and user controls

Completed workflow, usage, feedback, and cache history is pruned after the instance's configured retention period, 30 days by default. The dashboard provides a retained workflow/usage summary export, logout, provider disconnection, and permanent deletion of the live harness account and managed workspace.

Account deletion cannot rewrite backups that already exist. Encrypted backups remain until the instance operator's disclosed backup-retention window expires. Server and proxy logs may also remain for the operator's documented security-retention period.

## Operator responsibilities

Public instance operators must publish their identity/contact method, lawful basis, jurisdiction-specific disclosures, exact retention periods, subprocessor/provider list, and process for privacy requests. They must secure the vault key and backups, use HTTPS, minimize provider access, and avoid enabling prompt-training providers without informed consent.

For this project's own repository and vulnerability handling, use the links in [SECURITY.md](./SECURITY.md). Do not submit personal data or credentials in a public issue.
