import assert from "node:assert/strict";
import test from "node:test";
import { validateCredentials } from "../src/provider-connections.js";
import { configuredProviders } from "../src/providers.js";
import { LiveCatalog } from "../src/catalog.js";

test("one NVIDIA key contributes the major free prototype model families", () => {
  const [provider] = configuredProviders({ OLLAMA_ENABLED: "false", NVIDIA_API_KEY: "nvapi-test" });
  assert.equal(provider?.id, "nvidia");
  const models = provider?.models.map((model) => model.id) ?? [];
  assert(models.includes("deepseek-ai/deepseek-v4-pro"));
  assert(models.includes("moonshotai/kimi-k2.6"));
  assert(models.includes("z-ai/glm-5.2"));
  assert(models.includes("nvidia/nemotron-3-ultra-550b-a55b"));
});

test("Z.AI exposes only the documented zero-price Flash variants", () => {
  const [provider] = configuredProviders({ OLLAMA_ENABLED: "false", ZAI_API_KEY: "zai-test" });
  assert.equal(provider?.id, "zai");
  assert.deepEqual(provider?.models.map((model) => model.id), ["glm-4.7-flash", "glm-4.5-flash", "glm-4.6v-flash"]);
});

test("Hugging Face monthly credits expose its OpenAI-compatible routed catalog", () => {
  const [provider] = configuredProviders({ OLLAMA_ENABLED: "false", HF_TOKEN: "hf_test" });
  assert.equal(provider?.id, "huggingface");
  assert.equal(provider?.quotaKind, "monthly-credit");
  assert(provider?.models.some((model) => model.id.includes("DeepSeek-V4-Pro")));
});

test("custom connectors require a safe URL and an explicit data policy", () => {
  assert.throws(() => validateCredentials("custom", {
    CUSTOM_PROVIDER_LABEL: "unsafe",
    CUSTOM_BASE_URL: "http://example.com/v1",
    CUSTOM_API_KEY: "key",
    CUSTOM_MODELS: "model",
    CUSTOM_DATA_MAY_TRAIN: "false",
  }), /must use HTTPS/);
  const credentials = validateCredentials("custom", {
    CUSTOM_PROVIDER_LABEL: "Example",
    CUSTOM_BASE_URL: "https://api.example.com/v1",
    CUSTOM_API_KEY: "key",
    CUSTOM_MODELS: "model-a,model-b",
    CUSTOM_DATA_MAY_TRAIN: "false",
  });
  assert.equal(credentials.CUSTOM_DATA_MAY_TRAIN, "false");
});

test("NVIDIA live discovery adds new chat models but excludes specialized endpoints", async () => {
  const [provider] = configuredProviders({ OLLAMA_ENABLED: "false", NVIDIA_API_KEY: "nvapi-test" });
  assert(provider);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ data: [
    { id: "new-lab/new-reasoning-model" },
    { id: "nvidia/embed-qa" },
  ] });
  try {
    await new LiveCatalog().refreshProvider(provider);
    assert(provider.models.some((model) => model.id === "new-lab/new-reasoning-model"));
    assert(!provider.models.some((model) => model.id === "nvidia/embed-qa"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
