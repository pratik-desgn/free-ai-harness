# Production operations

The supported production layout is Caddy (public TLS) -> the harness on a private Compose network. The application container runs as UID/GID `10001`, has no Linux capabilities, uses a read-only root filesystem, and persists only its SQLite state and managed workspace in named volumes. The application port is exposed only to the Compose network, never published on the host.

## Prerequisites

- A Linux host with Docker Engine and Docker Compose v2
- A DNS A/AAAA record for the chosen hostname pointing to the host
- Inbound TCP 80 and TCP/UDP 443 allowed through the firewall
- At least 2 CPU cores, 2 GiB RAM, and enough disk for workspace artifacts

Do not publish port 8790. It is an internal cleartext hop. Caddy obtains and renews the public certificate and supplies the trusted client forwarding headers used by application rate limits.

## First deployment

From the repository root:

```bash
cp deploy/.env.production.example deploy/.env
chmod 600 deploy/.env
openssl rand -hex 32
openssl rand -hex 32
```

Put the two independent generated values in `HARNESS_VAULT_KEY` and `HARNESS_API_KEY`. Set a long, unrelated `HARNESS_LOGIN_PASSWORD`, the public `HARNESS_DOMAIN`, and `ACME_EMAIL`. The checked-in `REPLACE_ME` values deliberately fail production startup. Never rotate `HARNESS_VAULT_KEY` without decrypting/re-encrypting the vault: existing provider credentials depend on it.

Compose interpolation and the container `env_file` are separate. The example intentionally keeps both sets of values in `deploy/.env`; `HARNESS_ENV_FILE` may instead point to a separately managed runtime file relative to `deploy/`.

```bash
docker compose --env-file deploy/.env -f deploy/docker-compose.yml config --quiet
docker compose --env-file deploy/.env -f deploy/docker-compose.yml build --pull
docker compose --env-file deploy/.env -f deploy/docker-compose.yml up -d
docker compose --env-file deploy/.env -f deploy/docker-compose.yml ps
```

Verify `https://$HARNESS_DOMAIN/`, log in, and perform one real model request. Container health proves the process and database readiness path; it does not prove authentication or that a third-party provider has remaining quota.

## Environment contract

| Variable | Required | Production guidance |
|---|---:|---|
| `HARNESS_VAULT_KEY` | yes | Use 32 random bytes encoded as 64 hex characters. Production rejects values shorter than 32 characters. Back it up separately. |
| `HARNESS_API_KEY` | recommended | Independent random secret used by machine API clients. Container health uses the non-sensitive readiness endpoint. |
| `HARNESS_LOGIN_PASSWORD` | recommended | Long independent administrator password. |
| `HARNESS_DOMAIN` | yes | Public DNS hostname; Compose/Caddy setting. |
| `ACME_EMAIL` | yes | Certificate-expiry and ACME account contact. |
| `HARNESS_SESSION_DAYS` | no | Prefer 7 or less for a public service. |
| `HARNESS_FREE_ONLY` | no | Keep `true` unless spending is explicitly authorized. |
| `HARNESS_ALLOW_TRAINING_DATA` | no | Keep `false` unless users have consented. |
| `HARNESS_SHARE_OPERATOR_CAPACITY` | no | Keep `false` to isolate user-owned capacity. |
| `HARNESS_REQUESTS_PER_MINUTE` | no | Per-user application limit; keep an edge/WAF limit as an additional layer. |
| `HARNESS_MAX_ACTIVE_RUNS_PER_USER` | no | Bounds concurrent autonomous work per user. |
| `HARNESS_MAX_GLOBAL_ACTIVE_RUNS` | no | Bounds autonomous workflows across the process. |
| `HARNESS_MAX_USER_RUNTIMES` | no | Caps in-memory user routing/catalog state; idle entries are evicted. |
| `HARNESS_RETENTION_DAYS` | no | Prunes completed run, usage, feedback, and expired cache history; default 30 days. |
| `HARNESS_MAX_OUTPUT_TOKENS` | no | Hard application ceiling for caller-requested model output. |
| `HARNESS_MAX_UPSTREAM_RESPONSE_BYTES` | no | Rejects oversized upstream bodies and prevents unbounded caching. |
| `HARNESS_DAILY_TOKEN_BUDGET` | no | Rolling per-user safety ceiling based on provider-reported usage; not an upstream billing control. |
| `HARNESS_ALLOW_USER_CODE_EXECUTION` | no | Ignored in production. Run untrusted code only in a separate disposable sandbox. |
| `HARNESS_REQUEST_TIMEOUT_MS` | no | The application allows the configured model timeout plus ten seconds for the inbound request. |
| provider keys | no | Use least-privilege keys and connect only intended operator providers. |

The image forces stable container paths and disables automatic Ollama startup. To use Ollama in production, run it as a separately secured service and deliberately configure a reachable URL; do not mount the host Docker socket.

## Upgrades and rollback

Back up before every upgrade:

```bash
./scripts/backup.sh /secure/backups/harness-before-upgrade.db
docker compose --env-file deploy/.env -f deploy/docker-compose.yml build --pull
docker compose --env-file deploy/.env -f deploy/docker-compose.yml up -d
```

Pin `HARNESS_IMAGE` to an immutable version or digest in a real release pipeline. Review migrations and test restoration in staging before production upgrades. To roll back application code, restore the previous image tag. Restore the database only when the schema/data must also be rolled back.

## Backup and restore

The backup helper uses SQLite's online backup API, so it produces a consistent snapshot while traffic continues:

```bash
chmod +x scripts/backup.sh scripts/restore.sh
./scripts/backup.sh /secure/backups/free-ai-harness.db
```

Encrypt backups at rest and copy them off-host. Retain the exact `HARNESS_VAULT_KEY` in a separate secret manager; losing it makes encrypted provider credentials unrecoverable. A useful baseline is daily backups retained for 7 days, weekly backups for 5 weeks, and a quarterly restore drill.

Both helpers read `deploy/.env` by default. Set `HARNESS_COMPOSE_ENV_FILE=/absolute/path/to/env` when the production Compose environment is stored elsewhere; the helpers also force Compose to use that same file for the application environment.

Restore is intentionally offline and keeps a consistent snapshot of the previous database beside `state.db` as `state.db.before-restore-<timestamp>`:

```bash
./scripts/restore.sh /secure/backups/free-ai-harness.db
```

After restoring, verify `/health/ready`, login, the authenticated `/health` response, user isolation, and one provider request.

## Monitoring and incident response

Monitor container health, restart count, disk usage, TLS expiry, request latency, provider `429`/`5xx` rates, and backup age. Logs are capped at five 10 MiB files per service and must not contain provider tokens or request bodies. The in-process limiter supports one harness replica; introduce a shared limiter and run coordinator before horizontal scaling.

Useful commands:

```bash
docker compose --env-file deploy/.env -f deploy/docker-compose.yml ps
docker compose --env-file deploy/.env -f deploy/docker-compose.yml logs --since=30m harness
curl --fail --silent --show-error "https://ai.example.com/health/ready"
```

For suspected credential exposure: revoke the affected upstream keys first, replace them in the harness, rotate `HARNESS_API_KEY` and administrator password, invalidate sessions as appropriate, and preserve logs/database snapshots for investigation. Vault-key rotation requires an application-supported migration and must not be attempted by simply replacing the environment value.

## Security checklist

- Terminate only through HTTPS; never publish the harness container port.
- Store `deploy/.env` with mode `0600` and limit host/root access.
- Keep user-owned and operator capacity separate.
- Keep prompt-training providers disabled unless the privacy policy and consent flow permit them.
- Apply host and Docker security updates promptly; rebuild from pinned release artifacts.
- Put host-level egress controls and an external WAF/rate limiter in front of high-risk public deployments.
- Keep the Caddy-to-harness network private and set `HARNESS_TRUST_PROXY=true` only there; never expose the harness container port directly.
- Test backups by restoring into staging; an untested backup is not a recovery plan.
