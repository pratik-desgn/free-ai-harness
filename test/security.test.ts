import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import { applySecurityHeaders, RateLimiter, requestClientId, validRequestOrigin } from "../src/security.js";

function request(method: string, headers: Record<string, string | string[]> = {}, remoteAddress = "127.0.0.1"): IncomingMessage {
  return { method, headers, socket: { remoteAddress } } as unknown as IncomingMessage;
}

test("rate limiting is isolated by key and resets at the window boundary", () => {
  const limiter = new RateLimiter();
  assert.deepEqual(limiter.take("alice", 2, 1_000, 10_000), { allowed: true, retryAfterSeconds: 1, remaining: 1 });
  assert.deepEqual(limiter.take("alice", 2, 1_000, 10_100), { allowed: true, retryAfterSeconds: 1, remaining: 0 });
  assert.deepEqual(limiter.take("alice", 2, 1_000, 10_200), { allowed: false, retryAfterSeconds: 1, remaining: 0 });
  assert.equal(limiter.take("bob", 2, 1_000, 10_200).allowed, true);
  assert.deepEqual(limiter.take("alice", 2, 1_000, 11_000), { allowed: true, retryAfterSeconds: 1, remaining: 1 });
});

test("origin checks reject cross-site mutations while allowing same-origin and read requests", () => {
  assert.equal(validRequestOrigin(request("GET", { origin: "https://evil.example", host: "app.example" }), "https://app.example"), true);
  assert.equal(validRequestOrigin(request("POST", { origin: "https://app.example", host: "internal:8790" }), "https://app.example"), true);
  assert.equal(validRequestOrigin(request("POST", { origin: "https://evil.example", host: "app.example" }), "https://app.example"), false);
  assert.equal(validRequestOrigin(request("POST", { origin: "not a url", host: "app.example" }), "https://app.example"), false);
});

test("forwarded client addresses are trusted only when proxy trust is explicit", () => {
  const proxied = request("GET", { "x-forwarded-for": "203.0.113.9, 10.0.0.2" }, "127.0.0.1");
  assert.equal(requestClientId(proxied, false), "127.0.0.1");
  assert.equal(requestClientId(proxied, true), "203.0.113.9");
});

test("security headers disable framing, sniffing, sensitive referrers, and HTML caching", () => {
  const headers = new Map<string, string | number | readonly string[]>();
  const response = {
    setHeader(name: string, value: string | number | readonly string[]) {
      headers.set(name.toLowerCase(), value);
      return this;
    },
  } as unknown as ServerResponse;
  applySecurityHeaders(response, "text/html; charset=utf-8");
  assert.equal(headers.get("x-content-type-options"), "nosniff");
  assert.equal(headers.get("x-frame-options"), "DENY");
  assert.equal(headers.get("referrer-policy"), "no-referrer");
  assert.equal(headers.get("cross-origin-resource-policy"), "same-origin");
  assert.equal(headers.get("x-robots-tag"), "noindex, nofollow");
  assert.equal(headers.get("cache-control"), "no-store");
});
