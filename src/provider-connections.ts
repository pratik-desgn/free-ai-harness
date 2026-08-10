export interface ConnectionDefinition {
  id: string;
  label: string;
  description: string;
  fields: Array<{ env: string; label: string; secret: boolean }>;
}

export const connectionDefinitions: ConnectionDefinition[] = [
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
  return credentials;
}

export function credentialsEnvironment(vaultValues: Record<string, Record<string, string>>): NodeJS.ProcessEnv {
  return Object.assign({}, process.env, ...Object.values(vaultValues));
}
