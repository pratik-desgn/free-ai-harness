import type { IncomingMessage, ServerResponse } from "node:http";

interface Bucket {
  count: number;
  resetsAt: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  take(key: string, limit: number, windowMs: number, now = Date.now()): { allowed: boolean; retryAfterSeconds: number; remaining: number } {
    if (!Number.isInteger(limit) || limit < 1 || !Number.isFinite(windowMs) || windowMs < 1) throw new Error("Invalid rate-limit configuration");
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetsAt <= now) {
      bucket = { count: 0, resetsAt: now + windowMs };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (this.buckets.size > 10_000) this.prune(now);
    return {
      allowed: bucket.count <= limit,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetsAt - now) / 1_000)),
      remaining: Math.max(0, limit - bucket.count),
    };
  }

  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) if (bucket.resetsAt <= now) this.buckets.delete(key);
  }
}

export function requestClientId(request: IncomingMessage, trustProxy = false): string {
  if (trustProxy) {
    const forwarded = request.headers["x-forwarded-for"];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
    if (first) return first.slice(0, 128);
  }
  return request.socket.remoteAddress ?? "unknown";
}

export function validRequestOrigin(request: IncomingMessage, publicOrigin?: string): boolean {
  if (!request.method || ["GET", "HEAD", "OPTIONS"].includes(request.method)) return true;
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const expected = publicOrigin ? new URL(publicOrigin).origin : new URL(`http://${request.headers.host ?? "localhost"}`).origin;
    return new URL(origin).origin === expected;
  } catch {
    return false;
  }
}

export function applySecurityHeaders(response: ServerResponse, contentType?: string, secure = false): void {
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=()");
  response.setHeader("cross-origin-resource-policy", "same-origin");
  if (secure) response.setHeader("strict-transport-security", "max-age=31536000; includeSubDomains");
  if (contentType?.includes("text/html")) response.setHeader("cache-control", "no-store");
}
