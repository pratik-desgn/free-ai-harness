import assert from "node:assert/strict";
import test from "node:test";
import { Gateway, NoProviderError } from "../src/gateway.js";
import type { ProviderSpec } from "../src/types.js";

function provider(id: string, quality: number): ProviderSpec {
  return {
    id,
    label: id,
    baseUrl: `https://${id}.example/v1`,
    apiKey: `${id}-secret`,
    freeEligible: true,
    dataMayTrain: false,
    models: [{ id: `${id}-model`, capabilities: ["text", "json", "tools"], context: 10_000, quality, speed: quality, coding: quality, reasoning: quality }],
  };
}

test("retryable provider failures fall through without leaking one provider's credential to another", async () => {
  const originalFetch = globalThis.fetch;
  const seen: Array<{ url: string; authorization: string | null }> = [];
  try {
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      seen.push({ url, authorization: new Headers(init?.headers).get("authorization") });
      return url.includes("primary")
        ? new Response("busy", { status: 429, headers: { "retry-after": "2" } })
        : Response.json({ choices: [{ message: { role: "assistant", content: "fallback" } }] });
    };
    const gateway = new Gateway([provider("primary", 90), provider("fallback", 80)], { freeOnly: true, allowTrainingData: false });
    const result = await gateway.complete({ model: "auto", messages: [{ role: "user", content: "hello" }] });
    assert.equal(result.candidate.provider.id, "fallback");
    assert.deepEqual(result.attempts, [{ provider: "primary", model: "primary-model", status: 429 }]);
    assert.deepEqual(seen, [
      { url: "https://primary.example/v1/chat/completions", authorization: "Bearer primary-secret" },
      { url: "https://fallback.example/v1/chat/completions", authorization: "Bearer fallback-secret" },
    ]);
    assert((gateway.runtime.get("primary")?.unavailableUntil ?? 0) > Date.now());
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("non-retryable authentication failures stop instead of spraying a bad request across providers", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => {
      calls += 1;
      return new Response("unauthorized", { status: 401 });
    };
    const gateway = new Gateway([provider("primary", 90), provider("fallback", 80)], { freeOnly: true, allowTrainingData: false });
    await assert.rejects(
      () => gateway.complete({ model: "auto", messages: [{ role: "user", content: "hello" }] }),
      (error: unknown) => error instanceof NoProviderError && /\"status\":401/.test(error.message),
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("transport failures temporarily remove a provider after three consecutive failures", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw new Error("network down"); };
    const primary = provider("primary", 90);
    const gateway = new Gateway([primary], { freeOnly: true, allowTrainingData: false });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await assert.rejects(() => gateway.complete({ model: "auto", messages: [{ role: "user", content: "hello" }] }), NoProviderError);
    }
    assert.equal(gateway.runtime.get("primary")?.failures, 3);
    assert((gateway.runtime.get("primary")?.unavailableUntil ?? 0) > Date.now());
    assert.equal(gateway.candidates({ model: "auto", messages: [{ role: "user", content: "hello" }] }).length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("provider allowance guards fail over before sending a quota-draining request", async () => {
  const originalFetch = globalThis.fetch;
  const primary = provider("primary", 90);
  primary.availabilityCheck = async () => { throw new Error("allowance exhausted"); };
  const seen: string[] = [];
  try {
    globalThis.fetch = async (input) => {
      seen.push(String(input));
      return Response.json({ choices: [{ message: { role: "assistant", content: "fallback" } }] });
    };
    const gateway = new Gateway([primary, provider("fallback", 80)], { freeOnly: true, allowTrainingData: false });
    const result = await gateway.complete({ model: "auto", messages: [{ role: "user", content: "hello" }] });
    assert.equal(result.candidate.provider.id, "fallback");
    assert.deepEqual(seen, ["https://fallback.example/v1/chat/completions"]);
    assert.match(result.attempts[0]?.error ?? "", /allowance exhausted/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
