# Reproducible release procedure

Production runs must use OCI digests, not mutable tags. The repository pins the Node and Caddy patch versions as convenient development defaults; tags alone are not a production supply-chain boundary.

## Source gate

Run from a clean checkout of the release commit:

```bash
npm ci --ignore-scripts
npm run check
node scripts/validate-deployment.mjs
./scripts/generate-sbom.sh release-artifacts
sha256sum -c release-artifacts/SHA256SUMS
git diff --exit-code
```

`validate-deployment.mjs` needs only the Docker Compose CLI, not a running daemon. It validates the fully merged Compose JSON, Dockerfile hardening, Caddy routing, health dependency, persistent data, TLS origin, and production tool restrictions.

## Resolve and record build inputs

Resolve the exact base-image manifest for the release platform and record it in the release evidence:

```bash
docker buildx imagetools inspect node:24.13.0-bookworm-slim
docker buildx imagetools inspect caddy:2.10.2-alpine
```

Set `NODE_IMAGE` and `CADDY_IMAGE` to references ending in `@sha256:<64 hex characters>`. For multi-platform builds, use the manifest-list digest. Review upstream release notes before changing either version.

## Build, attest, and publish

Use a registry repository controlled by the operator. BuildKit creates an image-level SPDX SBOM and a maximal provenance attestation alongside the image:

```bash
export RELEASE_VERSION=0.1.0
export RELEASE_REVISION=$(git rev-parse HEAD)
export NODE_IMAGE='node:24.13.0-bookworm-slim@sha256:...'
export RELEASE_IMAGE="registry.example.com/free-ai-harness:${RELEASE_VERSION}"

docker buildx build \
  --pull \
  --platform linux/amd64,linux/arm64 \
  --build-arg NODE_IMAGE="$NODE_IMAGE" \
  --build-arg VERSION="$RELEASE_VERSION" \
  --build-arg REVISION="$RELEASE_REVISION" \
  --provenance=mode=max \
  --sbom=true \
  --tag "$RELEASE_IMAGE" \
  --push .
```

Resolve the pushed manifest digest and put that immutable reference in the deployment environment:

```bash
docker buildx imagetools inspect "$RELEASE_IMAGE"
# deploy/.env
HARNESS_IMAGE=registry.example.com/free-ai-harness@sha256:...
CADDY_IMAGE=caddy:2.10.2-alpine@sha256:...
NODE_IMAGE=node:24.13.0-bookworm-slim@sha256:...
```

Scan the immutable image, not only the source dependency tree. For example, with Trivy installed:

```bash
trivy image --exit-code 1 --severity HIGH,CRITICAL \
  'registry.example.com/free-ai-harness@sha256:...'
```

Sign the manifest digest and attestations with the organization's established signing system. Archive the commit ID, image digest, base-image digests, dependency SBOMs, image SBOM/provenance, vulnerability report, signatures, test output, and `SHA256SUMS` together as release evidence. Do not waive a finding merely because the vulnerable package is not imported by the application; document the reachability and compensating control in the release record.

## Immutable deployment gate

The strict validator rejects any tag-only application, Caddy, or Node build input:

```bash
REQUIRE_IMMUTABLE_IMAGES=true node scripts/validate-deployment.mjs deploy/.env
docker compose --env-file deploy/.env -f deploy/docker-compose.yml pull
docker compose --env-file deploy/.env -f deploy/docker-compose.yml up -d --no-build --remove-orphans
```

The production systemd unit enforces the same validator and uses `pull` plus `up --no-build`. A source checkout therefore cannot silently rebuild different bytes during a production restart.

## Post-deploy evidence

Do not treat container health alone as deployment success. Record all of:

```bash
docker compose --env-file deploy/.env -f deploy/docker-compose.yml ps
curl --fail --silent --show-error "https://ai.example.com/health/live"
curl --fail --silent --show-error "https://ai.example.com/health/ready"
```

Then verify administrator or Puter login, an authenticated `/health` response, one real model request, user isolation, provider failover, and current backup age. Roll back by selecting the previously recorded application digest and running the immutable deployment commands again.
