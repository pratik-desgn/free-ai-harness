import type { ProviderSpec } from "./types.js";

export interface CatalogStatus {
  checkedAt: string;
  healthy: boolean;
  availableModels: string[];
  error?: string;
}

export class LiveCatalog {
  private readonly status = new Map<string, CatalogStatus>();

  get(providerId: string): CatalogStatus | null {
    return this.status.get(providerId) ?? null;
  }

  async refresh(providers: ProviderSpec[]): Promise<void> {
    await Promise.allSettled(providers.map((provider) => this.refreshProvider(provider)));
  }

  async refreshProvider(provider: ProviderSpec): Promise<void> {
    const checkedAt = new Date().toISOString();
    try {
      const response = await fetch(provider.modelsUrl ?? `${provider.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${provider.apiKey}`, ...provider.extraHeaders },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json() as { data?: Array<{ id?: string }>; models?: Array<{ id?: string; puterId?: string; name?: string; model?: string }> };
      const availableModels = payload.data?.map((item) => item.id).filter((id): id is string => Boolean(id))
        ?? payload.models?.map((item) => item.id ?? item.puterId ?? item.model ?? item.name).filter((id): id is string => Boolean(id))
        ?? [];
      if (["puter", "nvidia", "huggingface"].includes(provider.id)) addDiscoveredChatModels(provider, availableModels);
      this.status.set(provider.id, { checkedAt, healthy: true, availableModels });
    } catch (error) {
      this.status.set(provider.id, { checkedAt, healthy: false, availableModels: [], error: error instanceof Error ? error.message : String(error) });
    }
  }
}

function addDiscoveredChatModels(provider: ProviderSpec, availableModels: string[]): void {
  const known = new Set(provider.models.map((model) => model.id));
  for (const id of availableModels) {
    if (known.has(id) || /(?:embed|rerank|guard|safety|moderation|gliner|retriev|translate|diffusion|image|video|audio|whisper|flux)/i.test(id)) continue;
    provider.models.push({
      id,
      capabilities: ["text"],
      context: 128_000,
      quality: 74,
      speed: /(?:flash|nano|mini|small|instant)/i.test(id) ? 90 : 72,
      coding: /(?:code|coder|deepseek|qwen|glm)/i.test(id) ? 82 : 72,
      reasoning: /(?:reason|thinking|deepseek|qwq|glm)/i.test(id) ? 84 : 74,
    });
    known.add(id);
  }
}
