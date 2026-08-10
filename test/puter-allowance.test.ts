import assert from "node:assert/strict";
import test from "node:test";
import { puterFreeAllowanceGuard, PuterAllowanceError } from "../src/puter-allowance.js";

test("Puter free-only guard allows reported allowance and caches a short-lived result", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ allowanceInfo: { remaining: 123 } }), { status: 200 });
  }) as typeof fetch;
  try {
    const guard = puterFreeAllowanceGuard(`positive-${crypto.randomUUID()}`);
    await guard();
    await guard();
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Puter free-only guard fails closed for exhausted, malformed, and unavailable allowance", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const response of [
      new Response(JSON.stringify({ allowanceInfo: { remaining: 0 } }), { status: 200 }),
      new Response(JSON.stringify({ allowanceInfo: {} }), { status: 200 }),
      new Response(null, { status: 503 }),
    ]) {
      globalThis.fetch = (async () => response.clone()) as typeof fetch;
      const guard = puterFreeAllowanceGuard(`blocked-${crypto.randomUUID()}`);
      await assert.rejects(guard, PuterAllowanceError);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
