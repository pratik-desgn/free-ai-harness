import assert from "node:assert/strict";
import test from "node:test";
import { Gateway, NoProviderError } from "../src/gateway.js";
import type { ProviderSpec } from "../src/types.js";

function puterProvider(): ProviderSpec {
  return {
    id: "puter",
    label: "Puter",
    baseUrl: "https://api.puter.com",
    chatTransport: "puter-driver",
    apiKey: "secret-puter-token",
    freeEligible: true,
    dataMayTrain: true,
    models: [{ id: "gpt-test", capabilities: ["text", "tools", "json"], context: 10_000, quality: 80, speed: 80, coding: 80, reasoning: 80 }],
  };
}

test("Puter chat uses the supported driver API and returns an OpenAI-compatible envelope", async () => {
  const originalFetch = globalThis.fetch;
  let wireBody: Record<string, unknown> = {};
  let authorization: string | null = "not-seen";
  try {
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input), "https://api.puter.com/drivers/call");
      assert.equal(new Headers(init?.headers).get("content-type"), "text/plain;actually=json");
      authorization = new Headers(init?.headers).get("authorization");
      wireBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        success: true,
        result: {
          finish_reason: "stop",
          message: { role: "assistant", content: "working" },
          usage: { prompt_tokens: 7, completion_tokens: 2, usd_cents: 0.001 },
        },
      });
    };
    const result = await new Gateway([puterProvider()], { freeOnly: true, allowTrainingData: true }).complete({
      model: "auto",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 8,
    });
    assert.equal(authorization, null);
    assert.equal(wireBody.interface, "puter-chat-completion");
    assert.equal(wireBody.driver, "ai-chat");
    assert.equal(wireBody.method, "complete");
    assert.equal(wireBody.auth_token, "secret-puter-token");
    assert.deepEqual(wireBody.args, { model: "gpt-test", messages: [{ role: "user", content: "hello" }], max_tokens: 8 });
    const envelope = await result.response.json() as { choices: Array<{ message: { content: string } }>; usage: { total_tokens: number } };
    assert.equal(envelope.choices[0]?.message.content, "working");
    assert.equal(envelope.usage.total_tokens, 9);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Puter driver failures are normalized for router failover", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ success: false, error: { code: "usage_limit_reached", message: "limit reached" } });
    const gateway = new Gateway([puterProvider()], { freeOnly: true, allowTrainingData: true });
    await assert.rejects(
      () => gateway.complete({ model: "auto", messages: [{ role: "user", content: "hello" }] }),
      (error: unknown) => error instanceof NoProviderError && /"status":429/.test(error.message),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Puter NDJSON is exposed as OpenAI-compatible server-sent events", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response([
      JSON.stringify({ type: "text", text: "Hi" }),
      JSON.stringify({ type: "usage", usage: { prompt_tokens: 3, completion_tokens: 1 } }),
      "",
    ].join("\n"), { headers: { "content-type": "application/x-ndjson" } });
    const result = await new Gateway([puterProvider()], { freeOnly: true, allowTrainingData: true }).complete({
      model: "auto",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    });
    const stream = await result.response.text();
    assert.match(stream, /"content":"Hi"/);
    assert.match(stream, /"total_tokens":4/);
    assert.match(stream, /data: \[DONE\]/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
