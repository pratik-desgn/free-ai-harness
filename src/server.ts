import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { rename, rm } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { AgentEngine } from "./agent.js";
import { Auth } from "./auth.js";
import { LiveCatalog } from "./catalog.js";
import { anthropicEnvelope, anthropicRequest, responsesEnvelope, responsesRequest } from "./compat.js";
import { Gateway, NoProviderError } from "./gateway.js";
import { ensureLocalProvider } from "./local-provider.js";
import { connectionDefinitions, credentialsEnvironment, unavailableServices, validateCredentials } from "./provider-connections.js";
import { configuredProviders } from "./providers.js";
import { PuterAuthError, verifyPuterToken } from "./puter-auth.js";
import { applySecurityHeaders, RateLimiter, requestClientId, validRequestOrigin } from "./security.js";
import { Store } from "./store.js";
import { specializedJson, specializedTranscription } from "./specialized.js";
import { builtInTools } from "./tools.js";
import type { ChatRequest } from "./types.js";
import { adminLoginHtml, dashboardHtml, loginHtml } from "./ui.js";
import { CredentialVault } from "./vault.js";

const port = positiveInteger("HARNESS_PORT", process.env.HARNESS_PORT ?? "8790", 65_535);
const host = process.env.HARNESS_HOST?.trim() || "127.0.0.1";
const publicOrigin = process.env.HARNESS_PUBLIC_ORIGIN?.trim() || undefined;
const trustProxy = process.env.HARNESS_TRUST_PROXY === "true";
const secureCookies = process.env.HARNESS_SECURE_COOKIES === "true" || publicOrigin?.startsWith("https://") === true;
const jsonBodyLimit = positiveInteger("HARNESS_JSON_BODY_LIMIT", process.env.HARNESS_JSON_BODY_LIMIT ?? "2097152", 10 * 1024 * 1024);
const uploadBodyLimit = positiveInteger("HARNESS_UPLOAD_BODY_LIMIT", process.env.HARNESS_UPLOAD_BODY_LIMIT ?? "10485760", 100 * 1024 * 1024);
const maxActiveRuns = positiveInteger("HARNESS_MAX_ACTIVE_RUNS_PER_USER", process.env.HARNESS_MAX_ACTIVE_RUNS_PER_USER ?? "3", 100);
const maxGlobalActiveRuns = positiveInteger("HARNESS_MAX_GLOBAL_ACTIVE_RUNS", process.env.HARNESS_MAX_GLOBAL_ACTIVE_RUNS ?? "50", 10_000);
const maxUserRuntimes = positiveInteger("HARNESS_MAX_USER_RUNTIMES", process.env.HARNESS_MAX_USER_RUNTIMES ?? "500", 100_000);
const retentionDays = positiveInteger("HARNESS_RETENTION_DAYS", process.env.HARNESS_RETENTION_DAYS ?? "30", 3650);
const requestsPerMinute = positiveInteger("HARNESS_REQUESTS_PER_MINUTE", process.env.HARNESS_REQUESTS_PER_MINUTE ?? "120", 100_000);
const requestTimeoutMs = positiveInteger("HARNESS_REQUEST_TIMEOUT_MS", process.env.HARNESS_REQUEST_TIMEOUT_MS ?? "120000", 900_000);
const cacheTtlMs = positiveInteger("HARNESS_CACHE_TTL_MS", process.env.HARNESS_CACHE_TTL_MS ?? "3600000", 86_400_000);
const sessionDays = positiveInteger("HARNESS_SESSION_DAYS", process.env.HARNESS_SESSION_DAYS ?? "30", 365);
const maxAgentSteps = positiveInteger("HARNESS_MAX_AGENT_STEPS", process.env.HARNESS_MAX_AGENT_STEPS ?? "12", 100);
const maxOutputTokens = positiveInteger("HARNESS_MAX_OUTPUT_TOKENS", process.env.HARNESS_MAX_OUTPUT_TOKENS ?? "8192", 131_072);
const dailyTokenBudget = positiveInteger("HARNESS_DAILY_TOKEN_BUDGET", process.env.HARNESS_DAILY_TOKEN_BUDGET ?? "5000000", 1_000_000_000);
const maxUpstreamResponseBytes = positiveInteger("HARNESS_MAX_UPSTREAM_RESPONSE_BYTES", process.env.HARNESS_MAX_UPSTREAM_RESPONSE_BYTES ?? "16777216", 100 * 1024 * 1024);
const rateLimiter = new RateLimiter();
const deletingUsers = new Set<string>();
const activeInferenceRequests = new Map<string, number>();
let shuttingDown = false;
process.umask(0o077);
validateProductionConfiguration();
const localProvider = await ensureLocalProvider();
const dataDirectory = resolve(process.env.HARNESS_DATA_DIR ?? ".harness");
const store = new Store(resolve(dataDirectory, "state.db"));
const vault = new CredentialVault(store, process.env.HARNESS_VAULT_KEY ?? process.env.HARNESS_LOGIN_PASSWORD ?? "");
let providers = configuredProviders(credentialsEnvironment(vault.all()));
const auth = new Auth(
  store,
  process.env.HARNESS_LOGIN_PASSWORD,
  process.env.HARNESS_API_KEY,
  sessionDays,
  secureCookies,
);
const gateway = new Gateway(
  providers,
  {
    freeOnly: process.env.HARNESS_FREE_ONLY !== "false",
    allowTrainingData: process.env.HARNESS_ALLOW_TRAINING_DATA === "true",
  },
  requestTimeoutMs,
  store,
  cacheTtlMs,
);
const catalog = new LiveCatalog();
const agent = new AgentEngine(
  gateway,
  store,
  builtInTools(resolve(process.env.HARNESS_WORKSPACE_ROOT ?? "workspace"), { allowExecution: process.env.NODE_ENV !== "production" }),
  maxAgentSteps,
);

interface UserRuntime {
  userId: string;
  lastUsed: number;
  providers: ReturnType<typeof configuredProviders>;
  gateway: Gateway;
  agent: AgentEngine;
  catalog: LiveCatalog;
}

const runtimes = new Map<string, UserRuntime>();
runtimes.set("operator", { userId: "operator", lastUsed: Date.now(), providers, gateway, agent, catalog });

store.pruneSessions();
pruneHistoricalData();
agent.resumePersisted();
void catalog.refresh(providers);
const catalogTimer = setInterval(() => void catalog.refresh(providers), 10 * 60_000);
catalogTimer.unref();
const maintenanceTimer = setInterval(() => {
  store.pruneSessions();
  pruneHistoricalData();
  evictIdleRuntimes();
}, 60 * 60_000);
maintenanceTimer.unref();

const server = createServer(async (request, response) => {
  const requestId = randomUUID();
  const requestStarted = performance.now();
  response.setHeader("x-request-id", requestId);
  response.once("finish", () => {
    if (!(request.url ?? "").startsWith("/health/")) console.log(JSON.stringify({
      event: "request", requestId, method: request.method, path: safeLogPath(request.url), status: response.statusCode,
      durationMs: Math.round((performance.now() - requestStarted) * 10) / 10,
    }));
  });
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    if (!validRequestOrigin(request, publicOrigin)) return json(response, 403, { error: { message: "Request origin is not allowed", type: "forbidden" } });
    if (request.method === "GET" && url.pathname === "/health/live") {
      return json(response, shuttingDown ? 503 : 200, { status: shuttingDown ? "stopping" : "ok" });
    }
    if (request.method === "GET" && url.pathname === "/health/ready") {
      const ready = !shuttingDown && store.ping();
      return json(response, ready ? 200 : 503, { status: ready ? "ready" : "not_ready" });
    }

    if (request.method === "POST" && url.pathname === "/auth/login") {
      if (!takeRateLimit(response, `login:${requestClientId(request, trustProxy)}`, 10, 15 * 60_000)) return;
      const body = await readJson<{ password?: string }>(request);
      if (!body.password || !auth.login(body.password, response)) {
        return json(response, 401, { error: { message: "Invalid login", type: "authentication_error" } });
      }
      return json(response, 200, { ok: true });
    }
    if (request.method === "POST" && url.pathname === "/auth/puter") {
      if (!takeRateLimit(response, `puter-login:${requestClientId(request, trustProxy)}`, 10, 15 * 60_000)) return;
      const body = await readJson<{ token?: string; displayName?: string }>(request);
      if (!body.token) return invalid(response, "Puter authorization is required");
      const identity = await verifyPuterToken(body.token, body.displayName);
      // A fresh upstream authorization is a credential rotation. Revoke every
      // older harness cookie before installing the replacement credential.
      store.deleteSessionsForUser(identity.id);
      store.upsertUser({ id: identity.id, provider: "puter", externalId: identity.externalId, displayName: identity.displayName });
      store.recordConsent(identity.id, "puter-broker-privacy-and-billing", "2026-08-10");
      vault.setForUser(identity.id, "puter", { PUTER_AUTH_TOKEN: body.token.trim() });
      runtimes.delete(identity.id);
      const userRuntime = runtimeFor(identity.id);
      const puter = userRuntime.providers.find((provider) => provider.id === "puter");
      if (puter) await userRuntime.catalog.refreshProvider(puter);
      auth.createUserSession(identity.id, response);
      return json(response, 200, { ok: true, user: { displayName: identity.displayName } });
    }
    if (request.method === "GET" && url.pathname === "/") {
      const signedIn = auth.authorized(request);
      return html(response, 200, signedIn ? dashboardHtml : loginHtml, !signedIn);
    }
    if (request.method === "GET" && url.pathname === "/admin/login") {
      return auth.authorized(request) ? redirect(response, "/") : html(response, 200, adminLoginHtml, false);
    }
    const principal = auth.principal(request);
    if (!principal) {
      return json(response, 401, { error: { message: "Log in to the harness", type: "authentication_error" } });
    }
    if (deletingUsers.has(principal.id)) return json(response, 409, { error: { message: "Account deletion is in progress", type: "conflict" } });
    if (isInferencePath(url.pathname)) trackInferenceRequest(principal.id, response);
    if (url.pathname.startsWith("/v1/") && !takeRateLimit(response, `api:${principal.id}`, requestsPerMinute, 60_000)) return;
    if (isInferencePath(url.pathname) && store.tokensUsedSince(principal.id, new Date(Date.now() - 86_400_000).toISOString()) >= dailyTokenBudget) {
      return json(response, 429, { error: { message: "Daily token safety budget is exhausted", type: "rate_limit_error" } });
    }
    if (request.method === "POST" && url.pathname === "/auth/logout") {
      auth.logout(request, response);
      return json(response, 200, { ok: true });
    }
    if (request.method === "POST" && url.pathname === "/auth/logout-all") {
      store.deleteSessionsForUser(principal.id);
      auth.logout(request, response);
      return json(response, 200, { ok: true });
    }
    if (request.method === "GET" && url.pathname === "/v1/account/export") {
      return json(response, 200, {
        user: { displayName: principal.displayName, provider: principal.provider },
        runs: store.listRuns(200, principal.id).map(publicRun),
        usage: store.usageSummary("1970-01-01T00:00:00.000Z", principal.id),
        exportedAt: new Date().toISOString(),
      });
    }
    if (request.method === "DELETE" && url.pathname === "/v1/user-providers/puter") {
      if (principal.provider !== "puter") return json(response, 403, { error: { message: "No user-owned Puter connection", type: "forbidden" } });
      if (store.activeRunCount(principal.id) > 0) return json(response, 409, { error: { message: "Finish or cancel active workflows before disconnecting", type: "conflict" } });
      store.deleteSessionsForUser(principal.id);
      vault.deleteForUser(principal.id, "puter");
      runtimes.delete(principal.id);
      auth.logout(request, response);
      return json(response, 200, { ok: true });
    }
    if (request.method === "DELETE" && url.pathname === "/v1/account") {
      if (principal.provider === "operator") return json(response, 403, { error: { message: "Administrator account cannot be deleted here", type: "forbidden" } });
      const body = await readJson<{ confirmation?: string }>(request);
      if (body.confirmation !== "DELETE") return invalid(response, "confirmation must equal DELETE");
      if (store.activeRunCount(principal.id) > 0) return json(response, 409, { error: { message: "Finish or cancel active workflows before deleting the account", type: "conflict" } });
      if ((activeInferenceRequests.get(principal.id) ?? 0) > 0) return json(response, 409, { error: { message: "Wait for active model requests to finish before deleting the account", type: "conflict" } });
      deletingUsers.add(principal.id);
      const workspace = userWorkspaceRoot(principal.id);
      const tombstone = `${workspace}.deleting-${randomUUID()}`;
      let movedWorkspace = false;
      try {
        try {
          await rename(workspace, tombstone);
          movedWorkspace = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (movedWorkspace) {
          try {
            await rm(tombstone, { recursive: true, force: true });
          } catch (error) {
            try { await rename(tombstone, workspace); } catch {}
            throw error;
          }
        }
        store.deleteUserAccount(principal.id);
        runtimes.delete(principal.id);
        auth.logout(request, response);
        return json(response, 200, { ok: true });
      } finally {
        deletingUsers.delete(principal.id);
      }
    }
    const runtime = runtimeFor(principal.id);
    if (request.method === "GET" && url.pathname === "/auth/me") {
      return json(response, 200, { authenticated: true, user: { displayName: principal.displayName, provider: principal.provider }, universalAi: runtime.providers.some((provider) => provider.id === "puter") });
    }
    if (request.method === "GET" && url.pathname === "/health") {
      return json(response, 200, {
        status: runtime.providers.length ? "ok" : "unconfigured",
        providers: runtime.providers.map((provider) => ({ id: provider.id, models: provider.models.length, quotaKind: provider.quotaKind, dataMayTrain: provider.dataMayTrain })),
      });
    }
    if (request.method === "GET" && url.pathname === "/v1/providers") {
      const active = new Set(runtime.providers.map((provider) => provider.id));
      if (principal.provider !== "operator") {
        const puter = runtime.providers.find((provider) => provider.id === "puter");
        return json(response, 200, { data: [{
          id: "universal-ai", label: "Universal AI", description: "Hundreds of models are available through your account and selected automatically.",
          connected: Boolean(puter), managed: true, fields: [], runtime: runtime.gateway.runtime.get("puter") ?? null,
          catalog: runtime.catalog.get("puter"),
        }] });
      }
      return json(response, 200, {
        data: [
          { id: "ollama", label: "Local Ollama", description: localProvider.message, connected: active.has("ollama"), managed: true, fields: [], runtime: runtime.gateway.runtime.get("ollama") ?? null, catalog: runtime.catalog.get("ollama") },
          ...connectionDefinitions.map((definition) => ({ ...definition, connected: active.has(definition.id), fields: definition.fields.map(({ env, label, secret }) => ({ env, label, secret })), runtime: runtime.gateway.runtime.get(definition.id) ?? null, catalog: runtime.catalog.get(definition.id) })),
          ...unavailableServices.map((definition) => ({ ...definition, connected: false, unavailable: true, managed: true, fields: [], runtime: null, catalog: null })),
        ],
      });
    }
    if (request.method === "GET" && url.pathname === "/v1/usage") {
      const days = Math.max(1, Math.min(365, Number(url.searchParams.get("days") ?? 30)));
      const since = new Date(Date.now() - days * 86_400_000).toISOString();
      return json(response, 200, { since, data: store.usageSummary(since, principal.id) });
    }
    const providerMatch = /^\/v1\/providers\/([a-z0-9-]+)$/.exec(url.pathname);
    if (request.method === "POST" && providerMatch?.[1]) {
      if (principal.provider !== "operator") return json(response, 403, { error: { message: "Provider administration is restricted", type: "forbidden" } });
      const body = await readJson<{ credentials?: unknown }>(request);
      const credentials = validateCredentials(providerMatch[1], body.credentials);
      vault.set(providerMatch[1], credentials);
      refreshProviders();
      const connected = providers.find((provider) => provider.id === providerMatch[1]);
      if (connected) await catalog.refreshProvider(connected);
      return json(response, 200, { id: providerMatch[1], connected: true });
    }
    if (request.method === "DELETE" && providerMatch?.[1]) {
      if (principal.provider !== "operator") return json(response, 403, { error: { message: "Provider administration is restricted", type: "forbidden" } });
      vault.delete(providerMatch[1]);
      refreshProviders();
      return json(response, 200, { id: providerMatch[1], connected: false });
    }
    if (request.method === "GET" && url.pathname === "/v1/models") {
      return json(response, 200, { object: "list", data: [{ id: "auto", object: "model", owned_by: "free-ai-harness" }] });
    }
    if (request.method === "POST" && url.pathname === "/v1/responses") {
      const body = await readJson<Record<string, unknown>>(request);
      if (body.model && body.model !== "auto") return invalid(response, "The harness exposes only model=auto");
      if (body.stream === true) return invalid(response, "Streaming Responses compatibility is not enabled yet");
      const result = await runtime.gateway.complete(boundedChatRequest(responsesRequest(body)), request.headers);
      const envelope = await responseJsonLimited<Record<string, unknown>>(result.response, maxUpstreamResponseBytes);
      recordKnownUsage(envelope, result, "responses", principal.id);
      response.setHeader("x-harness-provider", result.candidate.provider.id);
      if (result.cacheHit) response.setHeader("x-harness-cache", "hit");
      return json(response, 200, responsesEnvelope(envelope));
    }
    if (request.method === "POST" && url.pathname === "/v1/messages") {
      const body = await readJson<Record<string, unknown>>(request);
      if (body.model && body.model !== "auto") return invalid(response, "The harness exposes only model=auto");
      if (body.stream === true) return invalid(response, "Streaming Anthropic compatibility is not enabled yet");
      const result = await runtime.gateway.complete(boundedChatRequest(anthropicRequest(body)), request.headers);
      const envelope = await responseJsonLimited<Record<string, unknown>>(result.response, maxUpstreamResponseBytes);
      recordKnownUsage(envelope, result, "anthropic", principal.id);
      response.setHeader("x-harness-provider", result.candidate.provider.id);
      if (result.cacheHit) response.setHeader("x-harness-cache", "hit");
      return json(response, 200, anthropicEnvelope(envelope));
    }
    if (request.method === "POST" && url.pathname === "/v1/embeddings") {
      const body = await readJson<Record<string, unknown>>(request);
      const result = await specializedJson("embeddings", runtime.providers, body, requestTimeoutMs);
      response.setHeader("x-harness-provider", result.providerId);
      return pipeResponse(response, result.response);
    }
    if (request.method === "POST" && url.pathname === "/v1/images/generations") {
      const body = await readJson<Record<string, unknown>>(request);
      const result = await specializedJson("images", runtime.providers, body, requestTimeoutMs);
      response.setHeader("x-harness-provider", result.providerId);
      return pipeResponse(response, result.response);
    }
    if (request.method === "POST" && url.pathname === "/v1/audio/transcriptions") {
      const raw = await readBuffer(request);
      const form = await new Request("http://localhost", { method: "POST", headers: { "content-type": request.headers["content-type"] ?? "" }, body: new Uint8Array(raw) }).formData();
      const result = await specializedTranscription(runtime.providers, form, requestTimeoutMs);
      response.setHeader("x-harness-provider", result.providerId);
      return pipeResponse(response, result.response);
    }
    if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
      const body = await readJson<ChatRequest>(request);
      if (!Array.isArray(body.messages)) return invalid(response, "messages must be an array");
      if (body.model && body.model !== "auto") return invalid(response, "The harness exposes only model=auto");
      const result = await runtime.gateway.complete(boundedChatRequest({ ...body, model: "auto" }), request.headers);
      void recordDirectUsage(result.response.clone(), result.candidate.provider.id, result.candidate.model.id, result.latencyMs, result.cacheHit ?? false, store, principal.id);
      if (responseTooLarge(result.response, maxUpstreamResponseBytes)) {
        await result.response.body?.cancel();
        return json(response, 502, { error: { message: "Upstream response exceeded safety limit", type: "upstream_error" } });
      }
      response.statusCode = result.response.status;
      applySecurityHeaders(response, result.response.headers.get("content-type") ?? undefined, secureCookies);
      response.setHeader("content-type", result.response.headers.get("content-type") ?? "application/json");
      response.setHeader("x-harness-provider", result.candidate.provider.id);
      response.setHeader("x-harness-model", result.candidate.model.id);
      if (result.cacheHit) response.setHeader("x-harness-cache", "hit");
      if (result.response.body) pipeBodyLimited(result.response.body, response, maxUpstreamResponseBytes);
      else response.end();
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/runs") {
      const body = await readJson<{ objective?: string }>(request);
      const objective = body.objective?.trim();
      if (!objective) return invalid(response, "objective is required");
      if (objective.length > 100_000) return invalid(response, "objective exceeds 100,000 characters");
      if (store.activeRunCount(principal.id) >= maxActiveRuns) return json(response, 429, { error: { message: `At most ${maxActiveRuns} workflows may run concurrently`, type: "rate_limit_error" } });
      if (store.totalActiveRunCount() >= maxGlobalActiveRuns) return json(response, 503, { error: { message: "Workflow capacity is temporarily full", type: "capacity_error" } });
      return json(response, 202, publicRun(runtime.agent.create(objective)));
    }
    if (request.method === "GET" && url.pathname === "/v1/runs") {
      return json(response, 200, { data: store.listRuns(Number(url.searchParams.get("limit") ?? 50), principal.id).map(publicRun) });
    }
    const runMatch = /^\/v1\/runs\/([0-9a-f-]+)$/.exec(url.pathname);
    if (request.method === "GET" && runMatch?.[1]) {
      const run = store.getRun(runMatch[1], principal.id);
      return run ? json(response, 200, publicRun(run)) : json(response, 404, { error: { message: "Run not found", type: "not_found" } });
    }
    const runActionMatch = /^\/v1\/runs\/([0-9a-f-]+)\/(cancel|resume)$/.exec(url.pathname);
    if (request.method === "POST" && runActionMatch?.[1] && runActionMatch[2]) {
      const run = runActionMatch[2] === "cancel" ? runtime.agent.cancel(runActionMatch[1]) : runtime.agent.resume(runActionMatch[1]);
      return run ? json(response, 200, publicRun(run)) : json(response, 404, { error: { message: "Run not found", type: "not_found" } });
    }
    const feedbackMatch = /^\/v1\/runs\/([0-9a-f-]+)\/feedback$/.exec(url.pathname);
    if (request.method === "POST" && feedbackMatch?.[1]) {
      const run = store.getRun(feedbackMatch[1], principal.id);
      if (!run || run.status !== "completed") return json(response, 404, { error: { message: "Completed run not found", type: "not_found" } });
      const body = await readJson<{ rating?: number }>(request);
      if (body.rating !== -1 && body.rating !== 1) return invalid(response, "rating must be -1 or 1");
      const route = [...run.events].reverse().find((event) => event.type === "model" && event.metadata?.provider && event.metadata?.model);
      if (!route?.metadata) return invalid(response, "run has no routing record");
      const providerId = String(route.metadata.provider);
      store.recordFeedback(run.id, providerId, String(route.metadata.model), body.rating, principal.id);
      applyFeedbackAdjustments();
      return json(response, 200, { ok: true });
    }
    return json(response, 404, { error: { message: "Not found", type: "invalid_request_error" } });
  } catch (error) {
    const status = error instanceof NoProviderError ? 503 : error instanceof PuterAuthError ? error.status : error instanceof SyntaxError ? 400 : 500;
    if (status >= 500) console.error(JSON.stringify({
      event: "request_error", requestId, status,
      error: error instanceof Error ? error.message : String(error),
      ...(process.env.NODE_ENV === "production" ? {} : { stack: error instanceof Error ? error.stack : undefined }),
    }));
    const message = error instanceof NoProviderError ? "All eligible AI providers are currently unavailable"
      : error instanceof PuterAuthError || error instanceof SyntaxError ? error.message
      : "Internal server error";
    return json(response, status, { error: { message, type: status === 401 ? "authentication_error" : "harness_error" } });
  }
});

function refreshProviders(): void {
  providers = configuredProviders(credentialsEnvironment(vault.all()));
  gateway.replaceProviders(providers);
  const operatorRuntime = runtimes.get("operator");
  if (operatorRuntime) operatorRuntime.providers = providers;
  applyFeedbackAdjustments();
}

function runtimeFor(userId: string): UserRuntime {
  const existing = runtimes.get(userId);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing;
  }
  evictIdleRuntimes(maxUserRuntimes - 1);
  if (userRuntimeCount() >= maxUserRuntimes) throw new NoProviderError("Runtime capacity is full");
  const userProviders = configuredProviders(userProviderEnvironment(userId));
  const userAuthorizedBroker = userProviders.some((provider) => provider.id === "puter");
  const userGateway = new Gateway(
    userProviders,
    {
      freeOnly: process.env.HARNESS_FREE_ONLY !== "false",
      allowTrainingData: process.env.HARNESS_ALLOW_TRAINING_DATA === "true" || userAuthorizedBroker,
    },
    requestTimeoutMs,
    {
      cacheGet: (key) => store.cacheGet(`${userId}:${key}`),
      cacheSet: (key, value, ttlMs) => {
        if (store.getUser(userId)) store.cacheSet(`${userId}:${key}`, value, ttlMs);
      },
    },
    cacheTtlMs,
  );
  const userCatalog = new LiveCatalog();
  const userAgent = new AgentEngine(
    userGateway,
    store,
    builtInTools(userWorkspaceRoot(userId), {
      allowNetwork: process.env.HARNESS_ALLOW_USER_NETWORK_TOOLS !== "false",
      allowWorkspace: process.env.HARNESS_ALLOW_USER_WORKSPACE_TOOLS !== "false",
      allowExecution: process.env.NODE_ENV !== "production" && process.env.HARNESS_ALLOW_USER_CODE_EXECUTION === "true",
    }),
    maxAgentSteps,
    userId,
  );
  const created = { userId, lastUsed: Date.now(), providers: userProviders, gateway: userGateway, agent: userAgent, catalog: userCatalog };
  runtimes.set(userId, created);
  applyFeedbackAdjustments();
  userAgent.resumePersisted();
  void userCatalog.refresh(userProviders);
  return created;
}

function userProviderEnvironment(userId: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  if (process.env.HARNESS_SHARE_OPERATOR_CAPACITY !== "true") {
    for (const definition of connectionDefinitions) {
      for (const field of definition.fields) delete environment[field.env];
    }
  }
  for (const credentials of Object.values(vault.allForUser(userId))) Object.assign(environment, credentials);
  return environment;
}

function userWorkspaceRoot(userId: string): string {
  return resolve(process.env.HARNESS_WORKSPACE_ROOT ?? "workspace", "users", userId.replace(/[^a-zA-Z0-9._-]/g, "_"));
}

function applyFeedbackAdjustments(): void {
  for (const current of runtimes.values()) {
    for (const [providerId, adjustment] of Object.entries(store.providerFeedbackAdjustments(current.userId))) {
      const previous = current.gateway.runtime.get(providerId) ?? { failures: 0, unavailableUntil: 0 };
      current.gateway.runtime.set(providerId, { ...previous, qualityAdjustment: adjustment });
    }
  }
}

function userRuntimeCount(): number {
  return [...runtimes.keys()].filter((userId) => userId !== "operator").length;
}

function evictIdleRuntimes(target = maxUserRuntimes): void {
  if (userRuntimeCount() <= target) return;
  const candidates = [...runtimes.values()]
    .filter((runtime) => runtime.userId !== "operator" && store.activeRunCount(runtime.userId) === 0)
    .sort((left, right) => left.lastUsed - right.lastUsed);
  while (userRuntimeCount() > target && candidates.length) {
    const oldest = candidates.shift();
    if (oldest) runtimes.delete(oldest.userId);
  }
}

function pruneHistoricalData(): void {
  const before = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
  store.pruneHistoricalData(before);
}

function trackInferenceRequest(userId: string, response: ServerResponse): void {
  activeInferenceRequests.set(userId, (activeInferenceRequests.get(userId) ?? 0) + 1);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const remaining = (activeInferenceRequests.get(userId) ?? 1) - 1;
    if (remaining > 0) activeInferenceRequests.set(userId, remaining);
    else activeInferenceRequests.delete(userId);
  };
  response.once("finish", release);
  response.once("close", release);
}

applyFeedbackAdjustments();

async function recordDirectUsage(response: Response, providerId: string, modelId: string, latencyMs: number, cacheHit: boolean, targetStore: Store, userId: string): Promise<void> {
  try {
    const contentType = response.headers.get("content-type") ?? "";
    let usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;
    if (contentType.includes("json")) {
      usage = (await responseJsonLimited<{ usage?: typeof usage }>(response, 1_000_000)).usage;
    } else if (contentType.includes("text/event-stream")) {
      const text = await responseTextLimited(response, 1_000_000);
      for (const line of text.split("\n")) {
        if (!line.startsWith("data:") || line.slice(5).trim() === "[DONE]") continue;
        try {
          const parsed = JSON.parse(line.slice(5).trim()) as { usage?: typeof usage };
          if (parsed.usage) usage = parsed.usage;
        } catch {}
      }
    } else return;
    if (userId !== "operator" && !targetStore.getUser(userId)) return;
    targetStore.recordUsage({
      providerId, modelId, endpoint: cacheHit ? "chat:cache" : "chat", status: response.status, latencyMs,
      promptTokens: cacheHit ? 0 : usage?.prompt_tokens ?? 0,
      completionTokens: cacheHit ? 0 : usage?.completion_tokens ?? 0,
      totalTokens: cacheHit ? 0 : usage?.total_tokens ?? 0,
      userId,
    });
  } catch {
    // Streaming and non-JSON provider responses cannot be counted here.
  }
}

function recordKnownUsage(envelope: Record<string, unknown>, result: Awaited<ReturnType<Gateway["complete"]>>, endpoint: string, userId: string): void {
  const usage = envelope.usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;
  store.recordUsage({
    providerId: result.candidate.provider.id, modelId: result.candidate.model.id, endpoint: result.cacheHit ? `${endpoint}:cache` : endpoint,
    promptTokens: result.cacheHit ? 0 : usage?.prompt_tokens ?? 0, completionTokens: result.cacheHit ? 0 : usage?.completion_tokens ?? 0,
    totalTokens: result.cacheHit ? 0 : usage?.total_tokens ?? 0, status: result.response.status, latencyMs: result.latencyMs,
    userId,
  });
}

server.listen(port, host, () => {
  console.log(`free-ai-harness listening on http://${host}:${port} with ${providers.length} provider(s)`);
  console.log(localProvider.message);
  if (!auth.configured()) console.warn("Set HARNESS_LOGIN_PASSWORD before exposing the service");
});

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const contentType = request.headers["content-type"];
  if (contentType && !contentType.toLowerCase().startsWith("application/json")) throw new SyntaxError("Content-Type must be application/json");
  return JSON.parse((await readBuffer(request, jsonBodyLimit)).toString("utf8")) as T;
}

async function readBuffer(request: IncomingMessage, limit = uploadBodyLimit): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > limit) throw new SyntaxError(`Request body exceeds ${limit} bytes`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function publicRun(run: ReturnType<Store["createRun"]>): Record<string, unknown> {
  return {
    id: run.id,
    status: run.status,
    objective: run.objective,
    step: run.step,
    events: run.events,
    result: run.result ?? null,
    error: run.error ?? null,
    created_at: run.createdAt,
    updated_at: run.updatedAt,
  };
}

function invalid(response: ServerResponse, message: string): void {
  json(response, 400, { error: { message, type: "invalid_request_error" } });
}

function json(response: ServerResponse, status: number, value: unknown): void {
  applySecurityHeaders(response, "application/json", secureCookies);
  response.setHeader("cache-control", "no-store");
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function html(response: ServerResponse, status: number, value: string, allowPuter = false): void {
  applySecurityHeaders(response, "text/html", secureCookies);
  const nonce = randomBytes(18).toString("base64url");
  const securedHtml = value.replaceAll("<style>", `<style nonce="${nonce}">`).replaceAll("<script>", `<script nonce="${nonce}">`);
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": `default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'${allowPuter ? " https://js.puter.com" : ""}; connect-src 'self'${allowPuter ? " https://puter.com https://*.puter.com wss://*.puter.com" : ""}; frame-src ${allowPuter ? "https://puter.com https://*.puter.com" : "'none'"}`,
  });
  response.end(securedHtml);
}

function redirect(response: ServerResponse, location: string): void {
  applySecurityHeaders(response, undefined, secureCookies);
  response.writeHead(303, { location, "cache-control": "no-store" });
  response.end();
}

function pipeResponse(response: ServerResponse, upstream: Response): void {
  if (responseTooLarge(upstream, maxUpstreamResponseBytes)) {
    void upstream.body?.cancel();
    json(response, 502, { error: { message: "Upstream response exceeded safety limit", type: "upstream_error" } });
    return;
  }
  applySecurityHeaders(response, upstream.headers.get("content-type") ?? undefined, secureCookies);
  response.statusCode = upstream.status;
  response.setHeader("content-type", upstream.headers.get("content-type") ?? "application/json");
  if (upstream.body) pipeBodyLimited(upstream.body, response, maxUpstreamResponseBytes);
  else response.end();
}

function responseTooLarge(response: Response, limit: number): boolean {
  const declared = Number(response.headers.get("content-length") ?? 0);
  return Number.isFinite(declared) && declared > limit;
}

function pipeBodyLimited(body: ReadableStream<Uint8Array>, response: ServerResponse, limit: number): void {
  let bytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      callback(bytes > limit ? new Error("Upstream response exceeded safety limit") : null, chunk);
    },
  });
  limiter.on("error", () => response.destroy());
  Readable.fromWeb(body as never).pipe(limiter).pipe(response);
}

async function responseJsonLimited<T>(response: Response, limit: number): Promise<T> {
  return JSON.parse(await responseTextLimited(response, limit)) as T;
}

async function responseTextLimited(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > limit) {
    await response.body?.cancel();
    throw new Error("Upstream response exceeded safety limit");
  }
  if (!response.body) throw new Error("Upstream response was empty");
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
        throw new Error("Upstream response exceeded safety limit");
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

function takeRateLimit(response: ServerResponse, key: string, limit: number, windowMs: number): boolean {
  const result = rateLimiter.take(key, limit, windowMs);
  response.setHeader("x-ratelimit-limit", String(limit));
  response.setHeader("x-ratelimit-remaining", String(result.remaining));
  if (result.allowed) return true;
  response.setHeader("retry-after", String(result.retryAfterSeconds));
  json(response, 429, { error: { message: "Too many requests; try again later", type: "rate_limit_error" } });
  return false;
}

function positiveInteger(name: string, raw: string, maximum: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  return value;
}

function safeLogPath(raw: string | undefined): string {
  if (!raw) return "/";
  try { return new URL(raw, "http://localhost").pathname.slice(0, 500); } catch { return "invalid"; }
}

function boundedChatRequest(request: ChatRequest): ChatRequest {
  const raw = request.max_tokens ?? request.max_completion_tokens ?? Math.min(2_048, maxOutputTokens);
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > maxOutputTokens) {
    throw new SyntaxError(`Requested output tokens must be an integer between 1 and ${maxOutputTokens}`);
  }
  const bounded: ChatRequest = { ...request, max_tokens: raw };
  delete bounded.max_completion_tokens;
  return bounded;
}

function isInferencePath(pathname: string): boolean {
  return ["/v1/chat/completions", "/v1/responses", "/v1/messages", "/v1/embeddings", "/v1/images/generations", "/v1/audio/transcriptions", "/v1/runs"].includes(pathname);
}

function validateProductionConfiguration(): void {
  if (publicOrigin) {
    const parsed = new URL(publicOrigin);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== publicOrigin.replace(/\/$/, "")) throw new Error("HARNESS_PUBLIC_ORIGIN must be an origin without a path");
    if (process.env.NODE_ENV === "production" && parsed.protocol !== "https:" && !["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) {
      throw new Error("Production HARNESS_PUBLIC_ORIGIN must use HTTPS");
    }
  }
  if (process.env.NODE_ENV !== "production") return;
  if (!/^[a-f0-9]{64}$/i.test(process.env.HARNESS_VAULT_KEY ?? "")) throw new Error("Production HARNESS_VAULT_KEY must be an independent 32-byte hex secret");
  if (!["127.0.0.1", "localhost", "::1"].includes(host) && !publicOrigin) throw new Error("Production non-loopback binding requires HARNESS_PUBLIC_ORIGIN");
  if (process.env.HARNESS_LOGIN_PASSWORD && process.env.HARNESS_LOGIN_PASSWORD.length < 16) throw new Error("Production HARNESS_LOGIN_PASSWORD must be at least 16 characters");
  if (process.env.HARNESS_API_KEY && !/^[a-f0-9]{64}$/i.test(process.env.HARNESS_API_KEY)) throw new Error("Production HARNESS_API_KEY must be an independent 32-byte hex secret");
}

server.requestTimeout = requestTimeoutMs + 10_000;
server.headersTimeout = 30_000;
server.keepAliveTimeout = 5_000;
server.maxHeadersCount = 100;

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    shuttingDown = true;
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 30_000).unref();
  });
}
