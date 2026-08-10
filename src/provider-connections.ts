export interface ConnectionDefinition {
  id: string;
  label: string;
  description: string;
  setupUrl?: string;
  fields: Array<{ env: string; label: string; secret: boolean }>;
}

export interface UnavailableServiceDefinition {
  id: string;
  label: string;
  description: string;
  reason: string;
}

export const connectionDefinitions: ConnectionDefinition[] = [
  { id: "nvidia", label: "NVIDIA NIM", description: "One free prototype key unlocks DeepSeek, Kimi, GLM, Nemotron, MiniMax, Qwen, and GPT-OSS endpoints", setupUrl: "https://build.nvidia.com/explore/discover?api-key=true", fields: [{ env: "NVIDIA_API_KEY", label: "NVIDIA API key", secret: true }] },
  { id: "zai", label: "Z.AI / GLM", description: "Direct recurring-free GLM Flash text and vision models", setupUrl: "https://z.ai/manage-apikey/apikey-list", fields: [{ env: "ZAI_API_KEY", label: "Z.AI API key", secret: true }] },
  { id: "huggingface", label: "Hugging Face Inference Providers", description: "Monthly free inference credit across a large routed model catalog", setupUrl: "https://huggingface.co/settings/tokens", fields: [{ env: "HF_TOKEN", label: "Hugging Face token", secret: true }] },
  { id: "groq", label: "Groq", description: "Recurring free-plan inference", fields: [{ env: "GROQ_API_KEY", label: "API key", secret: true }] },
  { id: "gemini", label: "Google Gemini", description: "Free tier; training-data policy applies", fields: [{ env: "GEMINI_API_KEY", label: "API key", secret: true }] },
  { id: "github", label: "GitHub Models", description: "Free prototyping quota", fields: [{ env: "GITHUB_MODELS_TOKEN", label: "Models token", secret: true }] },
  { id: "openrouter", label: "OpenRouter", description: "Free-model router", fields: [{ env: "OPENROUTER_API_KEY", label: "API key", secret: true }] },
  {
    id: "cloudflare", label: "Cloudflare Workers AI", description: "Daily free neuron allocation", fields: [
      { env: "CLOUDFLARE_API_TOKEN", label: "API token", secret: true },
      { env: "CLOUDFLARE_ACCOUNT_ID", label: "Account ID", secret: false },
    ],
  },
  { id: "mistral", label: "Mistral", description: "Studio free mode", fields: [{ env: "MISTRAL_API_KEY", label: "API key", secret: true }] },
  { id: "cerebras", label: "Cerebras", description: "Free or trial inference", fields: [{ env: "CEREBRAS_API_KEY", label: "API key", secret: true }] },
  { id: "sambanova", label: "SambaNova", description: "Free or trial inference", fields: [{ env: "SAMBANOVA_API_KEY", label: "API key", secret: true }] },
  {
    id: "custom", label: "Custom OpenAI-compatible API", description: "Connect another legitimate free endpoint without changing harness code", fields: [
      { env: "CUSTOM_PROVIDER_LABEL", label: "Provider label", secret: false },
      { env: "CUSTOM_BASE_URL", label: "Base URL ending in /v1", secret: false },
      { env: "CUSTOM_API_KEY", label: "API key", secret: true },
      { env: "CUSTOM_MODELS", label: "Comma-separated model IDs", secret: false },
      { env: "CUSTOM_DATA_MAY_TRAIN", label: "May train on prompts? true/false", secret: false },
    ],
  },
];

export const unavailableServices: UnavailableServiceDefinition[] = [
  {
    id: "higgsfield",
    label: "Higgsfield",
    description: "Consumer image/video subscription",
    reason: "No public general API is currently available; consumer credits cannot be automated by sharing a website login.",
  },
  {
    id: "deepseek-direct",
    label: "DeepSeek direct API",
    description: "Direct usage is metered against account balance",
    reason: "Use DeepSeek through NVIDIA's free prototype endpoint. Direct DeepSeek is excluded while free-only mode is enabled to prevent charges.",
  },
  {
    id: "kimi-direct",
    label: "Kimi direct API",
    description: "Moonshot platform account",
    reason: "Use Kimi through NVIDIA's free prototype endpoint. A Kimi consumer login is not an API credential.",
  },
];

export function validateCredentials(providerId: string, value: unknown): Record<string, string> {
  const definition = connectionDefinitions.find((candidate) => candidate.id === providerId);
  if (!definition) throw new Error("Unknown provider");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("credentials must be an object");
  const input = value as Record<string, unknown>;
  const credentials: Record<string, string> = {};
  for (const field of definition.fields) {
    const fieldValue = input[field.env];
    if (typeof fieldValue !== "string" || !fieldValue.trim()) throw new Error(`${field.label} is required`);
    credentials[field.env] = fieldValue.trim();
  }
  if (providerId === "custom") validateCustom(credentials);
  return credentials;
}

function validateCustom(credentials: Record<string, string>): void {
  const url = new URL(credentials.CUSTOM_BASE_URL ?? "");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname))) {
    throw new Error("Custom provider must use HTTPS; HTTP is allowed only for localhost");
  }
  if (!(credentials.CUSTOM_MODELS ?? "").split(",").some((id) => id.trim())) throw new Error("At least one model ID is required");
  if (!/^(true|false)$/.test(credentials.CUSTOM_DATA_MAY_TRAIN ?? "")) throw new Error("Training policy must be true or false");
}

export function credentialsEnvironment(vaultValues: Record<string, Record<string, string>>): NodeJS.ProcessEnv {
  return Object.assign({}, process.env, ...Object.values(vaultValues));
}
