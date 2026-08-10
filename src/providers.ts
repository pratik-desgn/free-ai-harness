import type { ModelSpec, ProviderSpec } from "./types.js";

const model = (
  id: string,
  context: number,
  quality: number,
  speed: number,
  coding: number,
  reasoning: number,
  capabilities: ModelSpec["capabilities"] = ["text", "tools", "json"],
): ModelSpec => ({ id, context, quality, speed, coding, reasoning, capabilities });

/**
 * This catalog is deliberately conservative. "Free eligible" means the vendor
 * documents a no-cost API path; it is not a promise that every account/model
 * has capacity. Live 429s and quota headers remain authoritative.
 */
export function configuredProviders(env: NodeJS.ProcessEnv = process.env): ProviderSpec[] {
  const candidates: Array<ProviderSpec | undefined> = [
    env.OLLAMA_ENABLED !== "false"
      ? {
          id: "ollama",
          label: "Local Ollama",
          baseUrl: env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434/v1",
          apiKey: "local-only",
          freeEligible: true,
          quotaKind: "recurring",
          dataMayTrain: false,
          models: [model(env.OLLAMA_MODEL ?? "qwen2.5:3b", 32_768, 70, 45, 75, 68)],
        }
      : undefined,
    env.GROQ_API_KEY
      ? {
          id: "groq",
          label: "Groq Free Plan",
          baseUrl: "https://api.groq.com/openai/v1",
          apiKey: env.GROQ_API_KEY,
          freeEligible: true,
          quotaKind: "recurring",
          dataMayTrain: false,
          models: [
            model("openai/gpt-oss-120b", 131_072, 88, 98, 91, 92),
            model("llama-3.3-70b-versatile", 131_072, 82, 96, 78, 80),
            model("llama-3.1-8b-instant", 131_072, 66, 100, 64, 58),
          ],
        }
      : undefined,
    env.NVIDIA_API_KEY
      ? {
          id: "nvidia",
          label: "NVIDIA NIM Free Prototype Endpoints",
          baseUrl: "https://integrate.api.nvidia.com/v1",
          apiKey: env.NVIDIA_API_KEY,
          freeEligible: true,
          quotaKind: "trial",
          dataMayTrain: false,
          models: [
            model("deepseek-ai/deepseek-v4-pro", 1_000_000, 97, 70, 98, 98),
            model("deepseek-ai/deepseek-v4-flash", 1_000_000, 93, 89, 95, 95),
            model("moonshotai/kimi-k2.6", 262_000, 96, 75, 97, 96, ["text", "vision", "tools", "json"]),
            model("z-ai/glm-5.2", 1_000_000, 96, 72, 97, 97),
            model("nvidia/nemotron-3-ultra-550b-a55b", 1_000_000, 95, 73, 95, 97),
            model("minimaxai/minimax-m2.7", 205_000, 91, 82, 93, 92),
            model("qwen/qwen3-coder-480b-a35b-instruct", 262_000, 92, 82, 97, 91),
            model("openai/gpt-oss-120b", 131_072, 88, 90, 91, 92),
          ],
        }
      : undefined,
    env.ZAI_API_KEY
      ? {
          id: "zai",
          label: "Z.AI Free GLM Flash",
          baseUrl: "https://api.z.ai/api/paas/v4",
          apiKey: env.ZAI_API_KEY,
          freeEligible: true,
          quotaKind: "recurring",
          dataMayTrain: false,
          models: [
            model("glm-4.7-flash", 200_000, 84, 87, 87, 88),
            model("glm-4.5-flash", 128_000, 80, 91, 84, 84),
            model("glm-4.6v-flash", 128_000, 83, 86, 83, 85, ["text", "vision", "tools", "json"]),
          ],
        }
      : undefined,
    env.HF_TOKEN
      ? {
          id: "huggingface",
          label: "Hugging Face Monthly Free Credit",
          baseUrl: "https://router.huggingface.co/v1",
          apiKey: env.HF_TOKEN,
          freeEligible: true,
          quotaKind: "monthly-credit",
          dataMayTrain: false,
          models: [
            model("deepseek-ai/DeepSeek-V4-Pro", 1_000_000, 96, 68, 97, 98),
            model("openai/gpt-oss-120b:fastest", 131_072, 88, 88, 91, 92),
            model("Qwen/Qwen3-Coder-480B-A35B-Instruct", 262_000, 92, 76, 97, 91),
            model("zai-org/GLM-4.5V", 128_000, 88, 72, 89, 90, ["text", "vision", "tools", "json"]),
          ],
        }
      : undefined,
    env.GEMINI_API_KEY
      ? {
          id: "gemini",
          label: "Google Gemini Free Tier",
          baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
          apiKey: env.GEMINI_API_KEY,
          freeEligible: true,
          quotaKind: "recurring",
          dataMayTrain: true,
          models: [
            model("gemini-2.5-flash", 1_048_576, 86, 93, 84, 85, ["text", "vision", "tools", "json"]),
            model("gemini-2.5-flash-lite", 1_048_576, 75, 99, 72, 68, ["text", "vision", "tools", "json"]),
          ],
        }
      : undefined,
    env.GITHUB_MODELS_TOKEN
      ? {
          id: "github",
          label: "GitHub Models Free Usage",
          baseUrl: "https://models.github.ai/inference",
          apiKey: env.GITHUB_MODELS_TOKEN,
          freeEligible: true,
          quotaKind: "recurring",
          dataMayTrain: false,
          models: [
            model("openai/gpt-4.1", 1_000_000, 92, 76, 94, 90, ["text", "vision", "tools", "json"]),
            model("openai/gpt-4.1-mini", 1_000_000, 84, 90, 87, 82, ["text", "vision", "tools", "json"]),
          ],
          extraHeaders: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
        }
      : undefined,
    env.OPENROUTER_API_KEY
      ? {
          id: "openrouter",
          label: "OpenRouter Free Models Router",
          baseUrl: "https://openrouter.ai/api/v1",
          apiKey: env.OPENROUTER_API_KEY,
          freeEligible: true,
          quotaKind: "recurring",
          dataMayTrain: true,
          models: [model("openrouter/free", 128_000, 72, 70, 70, 72, ["text", "vision", "tools", "json"])],
        }
      : undefined,
    env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ACCOUNT_ID
      ? {
          id: "cloudflare",
          label: "Cloudflare Workers AI Free Allocation",
          baseUrl: `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/v1`,
          apiKey: env.CLOUDFLARE_API_TOKEN,
          freeEligible: true,
          quotaKind: "recurring",
          dataMayTrain: false,
          models: [
            model("@cf/openai/gpt-oss-120b", 128_000, 86, 84, 89, 90),
            model("@cf/meta/llama-3.1-8b-instruct", 128_000, 65, 93, 62, 57),
          ],
        }
      : undefined,
    env.MISTRAL_API_KEY
      ? {
          id: "mistral",
          label: "Mistral Studio Free Mode",
          baseUrl: "https://api.mistral.ai/v1",
          apiKey: env.MISTRAL_API_KEY,
          freeEligible: true,
          quotaKind: "variable",
          dataMayTrain: true,
          models: [model("mistral-small-latest", 128_000, 82, 90, 83, 80)],
        }
      : undefined,
    env.CEREBRAS_API_KEY
      ? {
          id: "cerebras",
          label: "Cerebras Free/Trial Tier",
          baseUrl: "https://api.cerebras.ai/v1",
          apiKey: env.CEREBRAS_API_KEY,
          freeEligible: true,
          quotaKind: "trial",
          dataMayTrain: false,
          models: [
            model("gpt-oss-120b", 131_072, 88, 100, 91, 92),
            model("qwen-3-235b-a22b-instruct-2507", 131_072, 86, 100, 85, 87),
            model("llama3.1-8b", 131_072, 66, 100, 64, 58),
          ],
        }
      : undefined,
    env.SAMBANOVA_API_KEY
      ? {
          id: "sambanova",
          label: "SambaNova Cloud Free Tier",
          baseUrl: "https://api.sambanova.ai/v1",
          apiKey: env.SAMBANOVA_API_KEY,
          freeEligible: true,
          quotaKind: "trial",
          dataMayTrain: false,
          models: [
            model("gpt-oss-120b", 131_072, 88, 96, 91, 92),
            model("DeepSeek-V3.1", 131_072, 87, 94, 86, 91),
            model("Meta-Llama-3.3-70B-Instruct", 131_072, 82, 96, 78, 80),
          ],
        }
      : undefined,
    env.CUSTOM_API_KEY && env.CUSTOM_BASE_URL && env.CUSTOM_MODELS
      ? {
          id: "custom",
          label: env.CUSTOM_PROVIDER_LABEL?.trim() || "Custom OpenAI-compatible API",
          baseUrl: normalizeBaseUrl(env.CUSTOM_BASE_URL),
          apiKey: env.CUSTOM_API_KEY,
          freeEligible: true,
          quotaKind: "variable",
          dataMayTrain: env.CUSTOM_DATA_MAY_TRAIN !== "false",
          models: env.CUSTOM_MODELS.split(",").map((id) => id.trim()).filter(Boolean).map((id) => model(id, 128_000, 72, 70, 72, 72)),
        }
      : undefined,
  ];

  return candidates.filter((provider): provider is ProviderSpec => provider !== undefined);
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname))) {
    throw new Error("Custom provider must use HTTPS (HTTP is allowed only for localhost)");
  }
  return url.toString().replace(/\/$/, "");
}
