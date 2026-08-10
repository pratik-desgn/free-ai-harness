import assert from "node:assert/strict";
import test from "node:test";
import { verifyPuterToken } from "../src/puter-auth.js";

test("Puter authorization is validated remotely and converted to an opaque identity", async () => {
  const originalFetch = globalThis.fetch;
  let authorization = "";
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    authorization = new Headers(init?.headers).get("authorization") ?? "";
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  }) as typeof fetch;
  try {
    const first = await verifyPuterToken("p".repeat(40), "Alice\nAdmin");
    const second = await verifyPuterToken("p".repeat(40), "Alice");
    assert.equal(authorization, `Bearer ${"p".repeat(40)}`);
    assert.equal(first.id, second.id);
    assert.equal(first.displayName, "AliceAdmin");
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
