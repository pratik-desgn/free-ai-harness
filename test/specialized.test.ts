import assert from "node:assert/strict";
import test from "node:test";
import { specializedJson } from "../src/specialized.js";
import type { ProviderSpec } from "../src/types.js";

const cloudflare: ProviderSpec = {
  id: "cloudflare",
  label: "Cloudflare",
  baseUrl: "https://api.cloudflare.com/client/v4/accounts/account-1/ai/v1",
  apiKey: "secret-token",
  freeEligible: true,
  quotaKind: "recurring",
  dataMayTrain: false,
  models: [],
};

test("Cloudflare images use the native Workers AI endpoint and normalize output", async () => {
  const originalFetch = globalThis.fetch;
  let calledUrl = "";
  let calledBody = "";
  globalThis.fetch = async (input, init) => {
    calledUrl = String(input);
    calledBody = String(init?.body);
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer secret-token");
    return Response.json({ result: { image: "base64-image" }, success: true });
  };
  try {
    const result = await specializedJson("images", [cloudflare], { prompt: "a rook", steps: 99 }, 1_000);
    assert.equal(calledUrl, "https://api.cloudflare.com/client/v4/accounts/account-1/ai/run/@cf/black-forest-labs/flux-1-schnell");
    assert.deepEqual(JSON.parse(calledBody), { prompt: "a rook", steps: 8 });
    const normalized = await result.response.json() as { created: number; data: Array<{ b64_json: string }> };
    assert.equal(typeof normalized.created, "number");
    assert.deepEqual(normalized.data, [{ b64_json: "base64-image" }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
