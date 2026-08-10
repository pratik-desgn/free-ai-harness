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
  ];

  return candidates.filter((provider): provider is ProviderSpec => provider !== undefined);
}
