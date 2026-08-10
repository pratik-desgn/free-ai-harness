import type { IncomingHttpHeaders } from "node:http";
import { createHash } from "node:crypto";
import type { Candidate, ChatRequest, ProviderRuntime, ProviderSpec } from "./types.js";
import { rankCandidates, type RouterOptions } from "./router.js";
import { puterChatCompletion } from "./puter-transport.js";

export class NoProviderError extends Error {}

export interface GatewayResult {
  response: Response;
  candidate: Candidate;
  attempts: Array<{ provider: string; model: string; status?: number; error?: string }>;
  latencyMs: number;
  cacheHit?: boolean;
}

export interface GatewayCache {
  cacheGet(cacheKey: string): { providerId: string; modelId: string; body: string; contentType: string } | undefined;
  cacheSet(cacheKey: string, value: { providerId: string; modelId: string; body: string; contentType: string }, ttlMs: number): void;
}

export class Gateway {
  readonly runtime = new Map<string, ProviderRuntime>();

  constructor(
    public providers: ProviderSpec[],
    readonly options: RouterOptions,
    readonly timeoutMs = 120_000,
    private readonly cache?: GatewayCache,
    private readonly cacheTtlMs = 3_600_000,
    private readonly maxCacheBytes = 1_000_000,
  ) {}

  replaceProviders(providers: ProviderSpec[]): void {
    this.providers = providers;
  }

  candidates(request: ChatRequest): Candidate[] {
    return rankCandidates(this.providers, this.runtime, request, this.options);
  }

  async complete(request: ChatRequest, incomingHeaders: IncomingHttpHeaders = {}): Promise<GatewayResult> {
    const candidates = this.candidates(request);
    if (!candidates.length) {
      throw new NoProviderError("No configured provider satisfies the request, privacy policy, and free-only policy");
    }
    const attempts: GatewayResult["attempts"] = [];
    const cacheKey = cacheable(request) ? requestCacheKey(request) : undefined;
    const cached = cacheKey ? this.cache?.cacheGet(cacheKey) : undefined;
    if (cached) {
      const candidate = candidates.find((item) => item.provider.id === cached.providerId && item.model.id === cached.modelId);
      if (candidate) {
        return {
          response: new Response(cached.body, { status: 200, headers: { "content-type": cached.contentType, "x-harness-cache": "hit" } }),
          candidate,
          attempts,
          latencyMs: 0,
          cacheHit: true,
        };
      }
    }

    for (const candidate of candidates) {
      const started = performance.now();
      try {
        await candidate.provider.availabilityCheck?.();
        const providerRequest = {
          ...request,
          model: candidate.model.id,
          ...(candidate.provider.id === "ollama"
            ? { think: false, max_tokens: Math.min(Number(request.max_tokens ?? 160), 160), temperature: request.temperature ?? 0.2 }
            : {}),
        };
        const response = candidate.provider.chatTransport === "puter-driver"
          ? await puterChatCompletion(candidate.provider, providerRequest, this.timeoutMs, this.maxCacheBytes)
          : await fetch(`${candidate.provider.baseUrl}/chat/completions`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${candidate.provider.apiKey}`,
                "Content-Type": "application/json",
                ...candidate.provider.extraHeaders,
                ...(typeof incomingHeaders["user-agent"] === "string" ? { "User-Agent": incomingHeaders["user-agent"] } : {}),
              },
              body: JSON.stringify(providerRequest),
              signal: AbortSignal.timeout(this.timeoutMs),
            });
        this.observe(candidate, response, performance.now() - started);
        if (response.ok) {
          if (cacheKey && this.cache) {
            const clone = response.clone();
            void readTextLimited(clone, this.maxCacheBytes).then((body) => {
              if (body !== undefined) this.cache?.cacheSet(cacheKey, {
                providerId: candidate.provider.id,
                modelId: candidate.model.id,
                body,
                contentType: clone.headers.get("content-type") ?? "application/json",
              }, this.cacheTtlMs);
            }).catch(() => undefined);
          }
          return { response, candidate, attempts, latencyMs: performance.now() - started, cacheHit: false };
        }

        attempts.push({ provider: candidate.provider.id, model: candidate.model.id, status: response.status });
        await response.body?.cancel();
        if (![408, 409, 429, 500, 502, 503, 504].includes(response.status)) break;
      } catch (error) {
        this.fail(candidate);
        attempts.push({
          provider: candidate.provider.id,
          model: candidate.model.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    throw new NoProviderError(`All compatible providers failed: ${JSON.stringify(attempts)}`);
  }

  private observe(candidate: Candidate, response: Response, latencyMs: number): void {
    const previous = this.runtime.get(candidate.provider.id) ?? { failures: 0, unavailableUntil: 0 };
    const remainingRequests = numericHeader(response.headers, ["x-ratelimit-remaining-requests", "ratelimit-remaining"]);
    const remainingTokens = numericHeader(response.headers, ["x-ratelimit-remaining-tokens"]);
    const next: ProviderRuntime = {
      failures: response.ok ? 0 : previous.failures + 1,
      unavailableUntil: response.status === 429 ? Date.now() + retryDelayMs(response.headers) : 0,
      latencyEwmaMs: previous.latencyEwmaMs === undefined ? latencyMs : previous.latencyEwmaMs * 0.7 + latencyMs * 0.3,
      ...(previous.qualityAdjustment === undefined ? {} : { qualityAdjustment: previous.qualityAdjustment }),
      ...(remainingRequests === undefined ? {} : { remainingRequests }),
      ...(remainingTokens === undefined ? {} : { remainingTokens }),
    };
    this.runtime.set(candidate.provider.id, next);
  }

  private fail(candidate: Candidate): void {
    const previous = this.runtime.get(candidate.provider.id) ?? { failures: 0, unavailableUntil: 0 };
    const failures = previous.failures + 1;
    this.runtime.set(candidate.provider.id, {
      ...previous,
      failures,
      unavailableUntil: failures >= 3 ? Date.now() + 30_000 : 0,
    });
  }
}

async function readTextLimited(response: Response, limit: number): Promise<string | undefined> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > limit) {
    await response.body?.cancel();
    return undefined;
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(output);
}

function cacheable(request: ChatRequest): boolean {
  return request.stream !== true && !request.tools?.length;
}

function requestCacheKey(request: ChatRequest): string {
  const stable = { ...request, model: "auto" };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

function numericHeader(headers: Headers, names: string[]): number | undefined {
  for (const name of names) {
    const value = headers.get(name);
    if (value !== null && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
}

function retryDelayMs(headers: Headers): number {
  const retryAfter = headers.get("retry-after");
  if (!retryAfter) return 60_000;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) return Math.max(1_000, seconds * 1_000);
  const date = Date.parse(retryAfter);
  return Number.isFinite(date) ? Math.max(1_000, date - Date.now()) : 60_000;
}
