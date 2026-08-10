import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const deploy = resolve(root, "deploy");
const suppliedEnv = process.argv[2] ? resolve(process.argv[2]) : undefined;
const temporaryDirectory = mkdtempSync(resolve(tmpdir(), "free-ai-harness-release-"));
const environmentFile = suppliedEnv ?? resolve(temporaryDirectory, "deployment.env");

try {
  if (!suppliedEnv) writeFileSync(environmentFile, readFileSync(resolve(deploy, ".env.production.example")));
  const compose = spawnSync("docker", ["compose", "--env-file", environmentFile, "-f", resolve(deploy, "docker-compose.yml"), "config", "--format", "json"], {
    cwd: root,
    env: { ...process.env, HARNESS_ENV_FILE: environmentFile },
    encoding: "utf8",
  });
  if (compose.error) fail(`Docker Compose CLI unavailable: ${compose.error.message}`);
  if (compose.status !== 0) fail(`Compose config failed:\n${compose.stderr.trim()}`);
  const config = JSON.parse(compose.stdout);
  validateCompose(config);
  validateDockerfile(readFileSync(resolve(root, "Dockerfile"), "utf8"));
  validateCaddyfile(readFileSync(resolve(deploy, "Caddyfile"), "utf8"));
  validateEnvironment(environmentFile, config);
  console.log("deployment validation: ok");
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}

function validateCompose(config) {
  const harness = config.services?.harness;
  const caddy = config.services?.caddy;
  assert(harness && caddy, "Compose must define harness and caddy services");
  assert(!harness.ports, "Harness port must never be published on the host");
  assert(harness.expose?.includes("8790"), "Harness must expose port 8790 to Caddy");
  assert(harness.environment?.HARNESS_HOST === "0.0.0.0", "Harness must bind the container network");
  assert(/^https:\/\//.test(harness.environment?.HARNESS_PUBLIC_ORIGIN ?? ""), "Production origin must use HTTPS");
  assert(harness.environment?.HARNESS_TRUST_PROXY === "true", "Caddy deployment must enable trusted proxy addresses");
  assert(harness.environment?.HARNESS_SECURE_COOKIES === "true", "Production cookies must be Secure");
  assert(harness.read_only === true && harness.cap_drop?.includes("ALL"), "Harness must use a read-only root and drop capabilities");
  assert(harness.security_opt?.includes("no-new-privileges:true"), "Harness must prohibit privilege escalation");
  assert(harness.volumes?.some((volume) => volume.target === "/var/lib/free-ai-harness"), "Harness data must be persistent");
  assert(caddy.depends_on?.harness?.condition === "service_healthy", "Caddy must wait for harness readiness");
  assert(caddy.ports?.some((port) => String(port.published) === "443"), "Caddy must publish TLS");

  if (process.env.REQUIRE_IMMUTABLE_IMAGES === "true") {
    assertDigest(harness.image, "HARNESS_IMAGE");
    assertDigest(caddy.image, "CADDY_IMAGE");
    assertDigest(harness.build?.args?.NODE_IMAGE, "NODE_IMAGE");
  }
}

function validateDockerfile(value) {
  assert(/ARG NODE_IMAGE=node:24\.13\.0-bookworm-slim/.test(value), "Dockerfile must default to the supported Node patch release");
  assert((value.match(/FROM \$\{NODE_IMAGE\}/g) ?? []).length === 2, "Both Docker stages must use NODE_IMAGE");
  assert(/npm ci --ignore-scripts/.test(value), "Docker build must use the lockfile without dependency lifecycle scripts");
  assert(/USER 10001:10001/.test(value), "Runtime image must be non-root");
  assert(/org\.opencontainers\.image\.licenses="MIT"/.test(value) && /LICENSE \/licenses\/free-ai-harness\/LICENSE/.test(value), "Runtime image must carry its license metadata and text");
  assert(/HEALTHCHECK[\s\S]*healthcheck\.mjs/.test(value), "Runtime image must define a health check");
  assert(/ENTRYPOINT \["node", "dist\/src\/server\.js"\]/.test(value), "Runtime must execute compiled code directly");
}

function validateCaddyfile(value) {
  assert(/^\{[\s\S]*admin off/m.test(value), "Caddy admin endpoint must be disabled");
  assert(/reverse_proxy harness:8790/.test(value), "Caddy must route only to harness:8790");
  assert(/Strict-Transport-Security/.test(value), "Caddy must emit HSTS");
}

function validateEnvironment(path, config) {
  const value = readFileSync(path, "utf8");
  for (const name of ["HARNESS_VAULT_KEY", "HARNESS_API_KEY", "HARNESS_LOGIN_PASSWORD"]) {
    assert(new RegExp(`^${name}=`, "m").test(value), `${name} must be present in the environment file`);
  }
  assert(config.services.harness.environment.HARNESS_ALLOW_USER_CODE_EXECUTION === "false", "Production must disable in-process user code execution");
  if (process.env.REQUIRE_IMMUTABLE_IMAGES === "true") {
    const environment = config.services.harness.environment;
    assert(/^[a-f0-9]{64}$/i.test(environment.HARNESS_VAULT_KEY ?? ""), "HARNESS_VAULT_KEY must be 32 random bytes encoded as hex");
    assert(!environment.HARNESS_API_KEY || environment.HARNESS_API_KEY.length >= 32, "HARNESS_API_KEY must be blank or at least 32 characters");
    assert(!environment.HARNESS_LOGIN_PASSWORD || environment.HARNESS_LOGIN_PASSWORD.length >= 16, "HARNESS_LOGIN_PASSWORD must be blank or at least 16 characters");
    const origin = new URL(environment.HARNESS_PUBLIC_ORIGIN);
    assert(!/(?:^|\.)example\.(?:com|net|org)$|\.(?:test|invalid|localhost)$/.test(origin.hostname), "HARNESS_DOMAIN must be a real production hostname");
    const email = config.services.caddy.environment?.ACME_EMAIL ?? "";
    assert(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) && !/@example\.(?:com|net|org)$/i.test(email), "ACME_EMAIL must be a real operator address");
  }
}

function assertDigest(image, name) {
  assert(typeof image === "string" && /@sha256:[a-f0-9]{64}$/i.test(image), `${name} must be pinned by sha256 digest for a release`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function fail(message) {
  throw new Error(`deployment validation failed: ${message}`);
}
