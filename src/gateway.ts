import type { IncomingHttpHeaders } from "node:http";
import type { Candidate, ChatRequest, ProviderRuntime, ProviderSpec } from "./types.js";
import { rankCandidates, type RouterOptions } from "./router.js";

export class NoProviderError extends Error {}

export interface GatewayResult {
  response: Response;
  candidate: Candidate;
  attempts: Array<{ provider: string; model: string; status?: number; error?: string }>;
}

export class Gateway {
  readonly runtime = new Map<string, ProviderRuntime>();

  constructor(
    readonly providers: ProviderSpec[],
    readonly options: RouterOptions,
    readonly timeoutMs = 120_000,
  ) {}

  candidates(request: ChatRequest): Candidate[] {
    return rankCandidates(this.providers, this.runtime, request, this.options);
  }

  async complete(request: ChatRequest, incomingHeaders: IncomingHttpHeaders = {}): Promise<GatewayResult> {
    const candidates = this.candidates(request);
    if (!candidates.length) {
      throw new NoProviderError("No configured provider satisfies the request, privacy policy, and free-only policy");
    }
    const attempts: GatewayResult["attempts"] = [];

    for (const candidate of candidates) {
      const started = performance.now();
      try {
        const response = await fetch(`${candidate.provider.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${candidate.provider.apiKey}`,
            "Content-Type": "application/json",
            ...candidate.provider.extraHeaders,
            ...(typeof incomingHeaders["user-agent"] === "string" ? { "User-Agent": incomingHeaders["user-agent"] } : {}),
          },
          body: JSON.stringify({ ...request, model: candidate.model.id }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        this.observe(candidate, response, performance.now() - started);
        if (response.ok) return { response, candidate, attempts };

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
