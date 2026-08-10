# Tailscale Funnel preview deployment

Tailscale Funnel can expose the localhost service over managed HTTPS without publishing port 8790. This is useful for a small preview or provider-login test; the digest-pinned Compose/Caddy layout in [OPERATIONS.md](./OPERATIONS.md) remains the production release target.

## Configure the application origin

Choose an unused Funnel HTTPS port allowed by the tailnet. Preserve any existing Funnel routes shown by `tailscale funnel status`.

Add the exact public origin to the ignored local `.env`:

```dotenv
HARNESS_PUBLIC_ORIGIN=https://machine.tailnet-name.ts.net:10000
HARNESS_TRUST_PROXY=true
HARNESS_SECURE_COOKIES=true
```

Use a 64-hex-character `HARNESS_VAULT_KEY` and a strong independent administrator password. Restart the enabled harness service, verify localhost readiness, then add only the unused route:

```bash
systemctl --user restart free-ai-harness.service
curl --fail http://127.0.0.1:8790/health/ready
tailscale funnel status
tailscale funnel --bg --https=10000 http://127.0.0.1:8790
curl --fail https://machine.tailnet-name.ts.net:10000/health/ready
```

Verify the public login page, hostile-Origin rejection, Secure/HttpOnly/SameSite cookie flags, an authenticated health request, and one real model call. Funnel is internet-public; normal Tailscale network membership is not required to reach it.

To remove only this preview route without disturbing other ports:

```bash
tailscale funnel --https=10000 off
```

Do not use `tailscale funnel reset` on a host that serves other projects.
