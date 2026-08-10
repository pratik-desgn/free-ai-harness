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
      const response = await fetch(`${provider.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${provider.apiKey}`, ...provider.extraHeaders },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json() as { data?: Array<{ id?: string }>; models?: Array<{ name?: string; model?: string }> };
      const availableModels = payload.data?.map((item) => item.id).filter((id): id is string => Boolean(id))
        ?? payload.models?.map((item) => item.model ?? item.name).filter((id): id is string => Boolean(id))
        ?? [];
      this.status.set(provider.id, { checkedAt, healthy: true, availableModels });
    } catch (error) {
      this.status.set(provider.id, { checkedAt, healthy: false, availableModels: [], error: error instanceof Error ? error.message : String(error) });
    }
  }
}
