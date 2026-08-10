import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Store } from "../src/store.js";

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
      HARNESS_JSON_BODY_LIMIT: "256",
      HARNESS_MAX_OUTPUT_TOKENS: "8",
      HARNESS_DAILY_TOKEN_BUDGET: "5",
      HARNESS_MAX_ACTIVE_RUNS_PER_USER: "2",
      HARNESS_MAX_GLOBAL_ACTIVE_RUNS: "1",
      HARNESS_MAX_USER_RUNTIMES: "1",
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

    const authenticatedRoot = await fetch(`${origin}/`, { headers: { cookie: cookie.split(";", 1)[0]! } });
    const authenticatedHtml = await authenticatedRoot.text();
    assert.match(authenticatedHtml, /What should we accomplish/);
    assert.doesNotMatch(authenticatedHtml, /js\.puter\.com/);
    const adminRedirect = await fetch(`${origin}/admin/login`, { headers: { cookie: cookie.split(";", 1)[0]! }, redirect: "manual" });
    assert.equal(adminRedirect.status, 303);
    assert.equal(adminRedirect.headers.get("location"), "/");

    const invalidTokens = await fetch(`${origin}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json", cookie: cookie.split(";", 1)[0]! },
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hello" }], max_tokens: 9 }),
    });
    assert.equal(invalidTokens.status, 400);
    assert.match(JSON.stringify(await invalidTokens.json()), /between 1 and 8/);

    const oversizedBody = await fetch(`${origin}/auth/login`, {
      method: "POST", headers: { "content-type": "application/json", origin: publicOrigin },
      body: JSON.stringify({ password: "x".repeat(300) }),
    });
    assert.equal(oversizedBody.status, 400);
    assert.match(JSON.stringify(await oversizedBody.json()), /exceeds 256 bytes/);

    const statePath = join(directory, "data", "state.db");
    const scopedStore = new Store(statePath);
    const session = (raw: string, userId: string) => {
      scopedStore.createSession(createHash("sha256").update(raw).digest("hex"), Date.now() + 60_000, userId);
      return `harness_session=${raw}`;
    };
    scopedStore.upsertUser({ id: "puter:alice", provider: "puter", externalId: "alice", displayName: "Alice" });
    scopedStore.upsertUser({ id: "puter:bob", provider: "puter", externalId: "bob", displayName: "Bob" });
    const aliceCookie = session("alice-session-token-for-smoke", "puter:alice");
    const bobCookie = session("bob-session-token-for-smoke", "puter:bob");

    assert.equal((await fetch(`${origin}/auth/me`, { headers: { cookie: aliceCookie } })).status, 200);
    const aliceActive = scopedStore.createRun("alice active", "puter:alice");
    assert.equal((await fetch(`${origin}/auth/me`, { headers: { cookie: bobCookie } })).status, 503);
    aliceActive.status = "cancelled";
    scopedStore.updateRun(aliceActive);
    assert.equal((await fetch(`${origin}/auth/me`, { headers: { cookie: bobCookie } })).status, 200);

    const aliceCompleted = scopedStore.createRun("alice private result", "puter:alice");
    aliceCompleted.status = "completed";
    aliceCompleted.events.push({ at: new Date().toISOString(), type: "model", message: "route", metadata: { provider: "puter", model: "alice-model" } });
    scopedStore.updateRun(aliceCompleted);
    const bobCompleted = scopedStore.createRun("bob public result", "puter:bob");
    bobCompleted.status = "completed";
    bobCompleted.events.push({ at: new Date().toISOString(), type: "model", message: "route", metadata: { provider: "puter", model: "bob-model" } });
    scopedStore.updateRun(bobCompleted);
    const crossFeedback = await fetch(`${origin}/v1/runs/${aliceCompleted.id}/feedback`, {
      method: "POST", headers: { "content-type": "application/json", cookie: bobCookie }, body: JSON.stringify({ rating: -1 }),
    });
    assert.equal(crossFeedback.status, 404);
    const ownFeedback = await fetch(`${origin}/v1/runs/${bobCompleted.id}/feedback`, {
      method: "POST", headers: { "content-type": "application/json", cookie: bobCookie }, body: JSON.stringify({ rating: 1 }),
    });
    assert.equal(ownFeedback.status, 200);
    assert.deepEqual(scopedStore.providerFeedbackAdjustments("puter:bob"), { puter: 1 });
    assert.deepEqual(scopedStore.providerFeedbackAdjustments("puter:alice"), {});

    const exported = await fetch(`${origin}/v1/account/export`, { headers: { cookie: bobCookie } });
    const exportedBody = JSON.stringify(await exported.json());
    assert.equal(exported.status, 200);
    assert.match(exportedBody, /bob public result/);
    assert.doesNotMatch(exportedBody, /alice private result/);

    const operatorOne = scopedStore.createRun("operator one", "operator");
    const operatorTwo = scopedStore.createRun("operator two", "operator");
    const perUserCap = await fetch(`${origin}/v1/runs`, {
      method: "POST", headers: { "content-type": "application/json", cookie: cookie.split(";", 1)[0]! }, body: JSON.stringify({ objective: "one too many" }),
    });
    assert.equal(perUserCap.status, 429);
    for (const run of [operatorOne, operatorTwo]) { run.status = "cancelled"; scopedStore.updateRun(run); }
    const globalBlocker = scopedStore.createRun("global blocker", "puter:alice");
    const globalCap = await fetch(`${origin}/v1/runs`, {
      method: "POST", headers: { "content-type": "application/json", cookie: cookie.split(";", 1)[0]! }, body: JSON.stringify({ objective: "blocked globally" }),
    });
    assert.equal(globalCap.status, 503);
    globalBlocker.status = "cancelled";
    scopedStore.updateRun(globalBlocker);

    scopedStore.recordUsage({ userId: "operator", providerId: "mock", modelId: "mock", endpoint: "chat", totalTokens: 5, status: 200, latencyMs: 1 });
    const dailyCap = await fetch(`${origin}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json", cookie: cookie.split(";", 1)[0]! },
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hello" }], max_tokens: 1 }),
    });
    assert.equal(dailyCap.status, 429);
    assert.match(JSON.stringify(await dailyCap.json()), /Daily token safety budget is exhausted/);

    const bobWorkspace = join(directory, "workspace", "users", "puter_bob");
    mkdirSync(bobWorkspace, { recursive: true });
    writeFileSync(join(bobWorkspace, "private.txt"), "delete me");
    const deleted = await fetch(`${origin}/v1/account`, {
      method: "DELETE", headers: { "content-type": "application/json", cookie: bobCookie }, body: JSON.stringify({ confirmation: "DELETE" }),
    });
    assert.equal(deleted.status, 200);
    assert.equal(scopedStore.getUser("puter:bob"), undefined);
    assert.equal(existsSync(bobWorkspace), false);
    assert.equal((await fetch(`${origin}/auth/me`, { headers: { cookie: bobCookie } })).status, 401);
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) resolve();
      else child.once("exit", () => resolve());
    });
    rmSync(directory, { recursive: true, force: true });
  }
  assert.match(output, /free-ai-harness listening/);
  assert.equal(child.exitCode, 0);
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
