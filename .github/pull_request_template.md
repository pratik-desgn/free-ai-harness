## What changed

Describe the behavior and why it belongs in the harness.

## Security and privacy

Describe effects on authentication, credentials, user data, provider billing, tools, networking, and tenant isolation. Write `None` only after checking each boundary.

## Verification

- [ ] `npm run check`
- [ ] `npm audit --omit=dev`
- [ ] Documentation updated when behavior or configuration changed
- [ ] No credentials, user data, databases, backups, logs, or local workspaces included
