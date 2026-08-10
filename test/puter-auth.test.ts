import assert from "node:assert/strict";
import test from "node:test";
import { verifyPuterToken } from "../src/puter-auth.js";

test("Puter authorization is validated remotely and converted to an opaque identity", async () => {
  const originalFetch = globalThis.fetch;
  let authorization = "";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    authorization = new Headers(init?.headers).get("authorization") ?? "";
    const url = String(input);
    return new Response(JSON.stringify(url.endsWith("/whoami") ? { uuid: "stable-puter-user", username: "Alice\nAdmin" } : { data: [] }), { status: 200 });
  }) as typeof fetch;
  try {
    const first = await verifyPuterToken("p".repeat(40), "Alice\nAdmin");
    const second = await verifyPuterToken("p".repeat(40), "Changed name");
    assert.equal(authorization, `Bearer ${"p".repeat(40)}`);
    assert.equal(first.id, second.id);
    assert.equal(first.displayName, "AliceAdmin");
    assert.equal(first.externalId, "stable-puter-user");
    assert.match(first.id, /^puter:[a-f0-9]{64}$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejected Puter credentials do not create an identity", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 401 })) as typeof fetch;
  try {
    await assert.rejects(() => verifyPuterToken("x".repeat(40)), /rejected/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Puter identity transport failures are reported as temporary upstream failures", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("network unavailable"); }) as typeof fetch;
  try {
    await assert.rejects(
      () => verifyPuterToken("x".repeat(40)),
      (error: unknown) => error instanceof Error && error.message === "Puter is temporarily unavailable" && (error as { status?: number }).status === 502,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Puter tokens are bounded before any network request", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    throw new Error("must not be called");
  }) as typeof fetch;
  try {
    await assert.rejects(() => verifyPuterToken("too-short"), /Invalid Puter authorization/);
    await assert.rejects(() => verifyPuterToken("x".repeat(8_193)), /Invalid Puter authorization/);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Puter authorization rejects malformed remote identities", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => Response.json(
    String(input).endsWith("/whoami") ? { uuid: "", username: "Alice" } : { data: [] },
  )) as typeof fetch;
  try {
    await assert.rejects(() => verifyPuterToken("p".repeat(40)), /invalid user identity/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
