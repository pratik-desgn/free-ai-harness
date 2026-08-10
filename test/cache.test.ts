import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Gateway } from "../src/gateway.js";
import { Store } from "../src/store.js";
import type { ProviderSpec } from "../src/types.js";

test("identical non-tool requests use the durable response cache", async () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-cache-"));
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "cached" } }] }), { headers: { "content-type": "application/json" } });
    };
    const provider: ProviderSpec = {
      id: "mock", label: "Mock", baseUrl: "https://example.invalid/v1", apiKey: "test", freeEligible: true, dataMayTrain: false,
      models: [{ id: "model", capabilities: ["text", "json"], context: 10_000, quality: 80, speed: 80, coding: 80, reasoning: 80 }],
    };
    const store = new Store(join(directory, "state.db"));
    const gateway = new Gateway([provider], { freeOnly: true, allowTrainingData: false }, 1_000, store, 60_000);
    const request = { model: "auto", messages: [{ role: "user" as const, content: "same" }] };
    await gateway.complete(request);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await gateway.complete(request);
    assert.equal(calls, 1);
    assert.equal(second.cacheHit, true);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("oversized provider responses are never persisted in the response cache", async () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-cache-limit-"));
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "x".repeat(500) } }] }), { headers: { "content-type": "application/json" } });
    };
    const provider: ProviderSpec = {
      id: "mock", label: "Mock", baseUrl: "https://example.invalid/v1", apiKey: "test", freeEligible: true, dataMayTrain: false,
      models: [{ id: "model", capabilities: ["text", "json"], context: 10_000, quality: 80, speed: 80, coding: 80, reasoning: 80 }],
    };
    const store = new Store(join(directory, "state.db"));
    const gateway = new Gateway([provider], { freeOnly: true, allowTrainingData: false }, 1_000, store, 60_000, 100);
    const request = { model: "auto", messages: [{ role: "user" as const, content: "same" }] };
    await gateway.complete(request);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await gateway.complete(request);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(directory, { recursive: true, force: true });
  }
});
