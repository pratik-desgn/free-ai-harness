import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { AgentEngine } from "./agent.js";
import { Auth } from "./auth.js";
import { LiveCatalog } from "./catalog.js";
import { anthropicEnvelope, anthropicRequest, responsesEnvelope, responsesRequest } from "./compat.js";
import { Gateway, NoProviderError } from "./gateway.js";
import { ensureLocalProvider } from "./local-provider.js";
import { connectionDefinitions, credentialsEnvironment, unavailableServices, validateCredentials } from "./provider-connections.js";
import { configuredProviders } from "./providers.js";
import { verifyPuterToken } from "./puter-auth.js";
import { Store } from "./store.js";
import { specializedJson, specializedTranscription } from "./specialized.js";
import { builtInTools } from "./tools.js";
import type { ChatRequest } from "./types.js";
import { dashboardHtml, loginHtml } from "./ui.js";
import { CredentialVault } from "./vault.js";

const port = Number(process.env.HARNESS_PORT ?? 8790);
const localProvider = await ensureLocalProvider();
const dataDirectory = resolve(process.env.HARNESS_DATA_DIR ?? ".harness");
const store = new Store(resolve(dataDirectory, "state.db"));
const vault = new CredentialVault(store, process.env.HARNESS_VAULT_KEY ?? process.env.HARNESS_LOGIN_PASSWORD ?? "");
let providers = configuredProviders(credentialsEnvironment(vault.all()));
const auth = new Auth(
  store,
  process.env.HARNESS_LOGIN_PASSWORD,
  process.env.HARNESS_API_KEY,
  Number(process.env.HARNESS_SESSION_DAYS ?? 30),
);
const gateway = new Gateway(
  providers,
  {
    freeOnly: process.env.HARNESS_FREE_ONLY !== "false",
    allowTrainingData: process.env.HARNESS_ALLOW_TRAINING_DATA === "true",
  },
  Number(process.env.HARNESS_REQUEST_TIMEOUT_MS ?? 120_000),
  store,
  Number(process.env.HARNESS_CACHE_TTL_MS ?? 3_600_000),
);
const requestTimeoutMs = Number(process.env.HARNESS_REQUEST_TIMEOUT_MS ?? 120_000);
const catalog = new LiveCatalog();
const agent = new AgentEngine(
  gateway,
  store,
  builtInTools(resolve(process.env.HARNESS_WORKSPACE_ROOT ?? "workspace")),
  Number(process.env.HARNESS_MAX_AGENT_STEPS ?? 12),
);

interface UserRuntime {
  providers: ReturnType<typeof configuredProviders>;
  gateway: Gateway;
  agent: AgentEngine;
  catalog: LiveCatalog;
}

const runtimes = new Map<string, UserRuntime>();
runtimes.set("operator", { providers, gateway, agent, catalog });

store.pruneSessions();
agent.resumePersisted();
void catalog.refresh(providers);
const catalogTimer = setInterval(() => void catalog.refresh(providers), 10 * 60_000);
catalogTimer.unref();

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    if (request.method === "POST" && url.pathname === "/auth/login") {
      const body = await readJson<{ password?: string }>(request);
      if (!body.password || !auth.login(body.password, response)) {
        return json(response, 401, { error: { message: "Invalid login", type: "authentication_error" } });
      }
      return json(response, 200, { ok: true });
    }
    if (request.method === "POST" && url.pathname === "/auth/puter") {
      const body = await readJson<{ token?: string; displayName?: string }>(request);
      if (!body.token) return invalid(response, "Puter authorization is required");
      const identity = await verifyPuterToken(body.token, body.displayName);
      store.upsertUser({ id: identity.id, provider: "puter", externalId: identity.externalId, displayName: identity.displayName });
      vault.setForUser(identity.id, "puter", { PUTER_AUTH_TOKEN: body.token.trim() });
      runtimes.delete(identity.id);
      const userRuntime = runtimeFor(identity.id);
      const puter = userRuntime.providers.find((provider) => provider.id === "puter");
      if (puter) await userRuntime.catalog.refreshProvider(puter);
      auth.createUserSession(identity.id, response);
      return json(response, 200, { ok: true, user: { displayName: identity.displayName } });
    }
    if (request.method === "GET" && url.pathname === "/") {
      return html(response, 200, auth.authorized(request) ? dashboardHtml : loginHtml);
    }
    const principal = auth.principal(request);
    if (!principal) {
      return json(response, 401, { error: { message: "Log in to the harness", type: "authentication_error" } });
    }
    const runtime = runtimeFor(principal.id);
    if (request.method === "POST" && url.pathname === "/auth/logout") {
      auth.logout(request, response);
      return json(response, 200, { ok: true });
    }
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
      const result = await runtime.gateway.complete(responsesRequest(body), request.headers);
      const envelope = await result.response.json() as Record<string, unknown>;
      recordKnownUsage(envelope, result, "responses", principal.id);
      response.setHeader("x-harness-provider", result.candidate.provider.id);
      if (result.cacheHit) response.setHeader("x-harness-cache", "hit");
      return json(response, 200, responsesEnvelope(envelope));
    }
    if (request.method === "POST" && url.pathname === "/v1/messages") {
      const body = await readJson<Record<string, unknown>>(request);
      if (body.model && body.model !== "auto") return invalid(response, "The harness exposes only model=auto");
      if (body.stream === true) return invalid(response, "Streaming Anthropic compatibility is not enabled yet");
      const result = await runtime.gateway.complete(anthropicRequest(body), request.headers);
      const envelope = await result.response.json() as Record<string, unknown>;
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
      const result = await runtime.gateway.complete({ ...body, model: "auto" }, request.headers);
      void recordDirectUsage(result.response.clone(), result.candidate.provider.id, result.candidate.model.id, result.latencyMs, result.cacheHit ?? false, store, principal.id);
      response.statusCode = result.response.status;
      response.setHeader("content-type", result.response.headers.get("content-type") ?? "application/json");
      response.setHeader("x-harness-provider", result.candidate.provider.id);
      response.setHeader("x-harness-model", result.candidate.model.id);
      if (result.cacheHit) response.setHeader("x-harness-cache", "hit");
      if (result.response.body) Readable.fromWeb(result.response.body as never).pipe(response);
      else response.end();
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/runs") {
      const body = await readJson<{ objective?: string }>(request);
      const objective = body.objective?.trim();
      if (!objective) return invalid(response, "objective is required");
      if (objective.length > 100_000) return invalid(response, "objective exceeds 100,000 characters");
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
      store.recordFeedback(run.id, providerId, String(route.metadata.model), body.rating);
      applyFeedbackAdjustments();
      return json(response, 200, { ok: true });
    }
    return json(response, 404, { error: { message: "Not found", type: "invalid_request_error" } });
  } catch (error) {
    const status = error instanceof NoProviderError ? 503 : error instanceof SyntaxError ? 400 : 500;
    return json(response, status, { error: { message: error instanceof Error ? error.message : String(error), type: "harness_error" } });
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
  if (existing) return existing;
  const userProviders = configuredProviders(userProviderEnvironment(userId));
  const userGateway = new Gateway(
    userProviders,
    {
      freeOnly: process.env.HARNESS_FREE_ONLY !== "false",
      allowTrainingData: process.env.HARNESS_ALLOW_TRAINING_DATA === "true",
    },
    requestTimeoutMs,
    {
      cacheGet: (key) => store.cacheGet(`${userId}:${key}`),
      cacheSet: (key, value, ttlMs) => store.cacheSet(`${userId}:${key}`, value, ttlMs),
    },
    Number(process.env.HARNESS_CACHE_TTL_MS ?? 3_600_000),
  );
  const userCatalog = new LiveCatalog();
  const userAgent = new AgentEngine(
    userGateway,
    store,
    builtInTools(resolve(process.env.HARNESS_WORKSPACE_ROOT ?? "workspace")),
    Number(process.env.HARNESS_MAX_AGENT_STEPS ?? 12),
    userId,
  );
  const created = { providers: userProviders, gateway: userGateway, agent: userAgent, catalog: userCatalog };
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

function applyFeedbackAdjustments(): void {
  for (const [providerId, adjustment] of Object.entries(store.providerFeedbackAdjustments())) {
    for (const current of runtimes.values()) {
      const previous = current.gateway.runtime.get(providerId) ?? { failures: 0, unavailableUntil: 0 };
      current.gateway.runtime.set(providerId, { ...previous, qualityAdjustment: adjustment });
    }
  }
}

applyFeedbackAdjustments();

async function recordDirectUsage(response: Response, providerId: string, modelId: string, latencyMs: number, cacheHit: boolean, targetStore: Store, userId: string): Promise<void> {
  if (!response.headers.get("content-type")?.includes("json")) return;
  try {
    const body = await response.json() as { usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } };
    targetStore.recordUsage({
      providerId, modelId, endpoint: cacheHit ? "chat:cache" : "chat", status: response.status, latencyMs,
      promptTokens: cacheHit ? 0 : body.usage?.prompt_tokens ?? 0,
      completionTokens: cacheHit ? 0 : body.usage?.completion_tokens ?? 0,
      totalTokens: cacheHit ? 0 : body.usage?.total_tokens ?? 0,
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

server.listen(port, "127.0.0.1", () => {
  console.log(`free-ai-harness listening on http://127.0.0.1:${port} with ${providers.length} provider(s)`);
  console.log(localProvider.message);
  if (!auth.configured()) console.warn("Set HARNESS_LOGIN_PASSWORD before exposing the service");
});

async function readJson<T>(request: IncomingMessage): Promise<T> {
  return JSON.parse((await readBuffer(request)).toString("utf8")) as T;
}

async function readBuffer(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 10 * 1024 * 1024) throw new SyntaxError("Request body exceeds 10 MiB");
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
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function html(response: ServerResponse, status: number, value: string): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'self' 'unsafe-inline' https://js.puter.com; connect-src 'self' https://puter.com https://*.puter.com wss://*.puter.com; frame-src https://puter.com https://*.puter.com",
  });
  response.end(value);
}

function pipeResponse(response: ServerResponse, upstream: Response): void {
  response.statusCode = upstream.status;
  response.setHeader("content-type", upstream.headers.get("content-type") ?? "application/json");
  if (upstream.body) Readable.fromWeb(upstream.body as never).pipe(response);
  else response.end();
}
