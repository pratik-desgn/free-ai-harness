import { createHash } from "node:crypto";

const USAGE_URL = "https://api.puter.com/metering/usage";
const CACHE_MS = 5_000;
const MAX_CACHE_ENTRIES = 1_000;
const cache = new Map<string, { checkedAt: number; remaining: number }>();

export class PuterAllowanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PuterAllowanceError";
  }
}

export function puterFreeAllowanceGuard(token: string): () => Promise<void> {
  return async () => {
    const key = createHash("sha256").update(token).digest("hex");
    const cached = cache.get(key);
    if (cached && Date.now() - cached.checkedAt < CACHE_MS) {
      if (cached.remaining <= 0) throw new PuterAllowanceError("Puter free allowance is exhausted");
      return;
    }
    const response = await fetch(USAGE_URL, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new PuterAllowanceError("Could not verify Puter free allowance");
    }
    const body = await response.json() as { allowanceInfo?: { remaining?: unknown } };
    const remaining = body.allowanceInfo?.remaining;
    if (typeof remaining !== "number" || !Number.isFinite(remaining)) throw new PuterAllowanceError("Puter returned invalid allowance information");
    if (cache.size >= MAX_CACHE_ENTRIES && !cache.has(key)) {
      const oldest = [...cache.entries()].sort((left, right) => left[1].checkedAt - right[1].checkedAt)[0]?.[0];
      if (oldest) cache.delete(oldest);
    }
    cache.set(key, { checkedAt: Date.now(), remaining });
    if (remaining <= 0) throw new PuterAllowanceError("Puter free allowance is exhausted");
  };
}
