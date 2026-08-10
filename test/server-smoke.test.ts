import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      assert(address && typeof address === "object");
      const port = address.port;
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForServer(origin: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early with ${child.exitCode}`);
    try {
      const response = await fetch(`${origin}/health/live`);
      if (response.ok) return;
    } catch {
      // The child has not bound the port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("server did not become ready");
}

test("spawned production server exposes health, authentication, origin, cookie, and CSP boundaries", { timeout: 20_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-server-smoke-"));
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const publicOrigin = "https://harness.example";
  let output = "";
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "production",
      HARNESS_PORT: String(port),
      HARNESS_HOST: "127.0.0.1",
      HARNESS_PUBLIC_ORIGIN: publicOrigin,
      HARNESS_DATA_DIR: join(directory, "data"),
      HARNESS_WORKSPACE_ROOT: join(directory, "workspace"),
      HARNESS_VAULT_KEY: "a".repeat(64),
      HARNESS_LOGIN_PASSWORD: "production-test-password",
      OLLAMA_ENABLED: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  try {
    await waitForServer(origin, child);
    const live = await fetch(`${origin}/health/live`);
    assert.equal(live.status, 200);
    assert.equal(live.headers.get("strict-transport-security"), "max-age=31536000; includeSubDomains");
    assert.deepEqual(await live.json(), { status: "ok" });
    assert.equal((await fetch(`${origin}/health/ready`)).status, 200);

    const root = await fetch(`${origin}/`);
    const html = await root.text();
    const csp = root.headers.get("content-security-policy") ?? "";
    assert.equal(root.status, 200);
    assert.match(csp, /script-src 'nonce-[A-Za-z0-9_-]+'/);
    assert.doesNotMatch(csp, /unsafe-inline/);
    assert.match(html, /<script nonce="[A-Za-z0-9_-]+">/);
    assert.equal((await fetch(`${origin}/v1/models`)).status, 401);

    const admin = await fetch(`${origin}/admin/login`);
    const adminHtml = await admin.text();
    const adminCsp = admin.headers.get("content-security-policy") ?? "";
    assert.equal(admin.status, 200);
    assert.doesNotMatch(adminCsp, /js\.puter\.com/);
    assert.doesNotMatch(adminHtml, /js\.puter\.com/);

    const forbidden = await fetch(`${origin}/auth/login`, {
      method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: JSON.stringify({ password: "production-test-password" }),
    });
    assert.equal(forbidden.status, 403);

    const login = await fetch(`${origin}/auth/login`, {
      method: "POST", headers: { "content-type": "application/json", origin: publicOrigin }, body: JSON.stringify({ password: "production-test-password" }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie") ?? "";
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Secure/);
    const me = await fetch(`${origin}/auth/me`, { headers: { cookie: cookie.split(";", 1)[0]! } });
    assert.equal(me.status, 200);
    assert.deepEqual((await me.json() as { authenticated: boolean }).authenticated, true);
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) resolve();
      else child.once("exit", () => resolve());
    });
    rmSync(directory, { recursive: true, force: true });
  }
  assert.match(output, /free-ai-harness listening/);
});

test("invalid production security configuration fails closed before binding", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "production",
      HARNESS_PORT: "8790",
      HARNESS_HOST: "0.0.0.0",
      HARNESS_PUBLIC_ORIGIN: "http://public.example",
      HARNESS_VAULT_KEY: "short",
      OLLAMA_ENABLED: "false",
    },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /Production HARNESS_PUBLIC_ORIGIN must use HTTPS/);
});
