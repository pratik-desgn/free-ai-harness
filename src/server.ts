import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { AgentEngine } from "./agent.js";
import { Auth } from "./auth.js";
import { LiveCatalog } from "./catalog.js";
import { anthropicEnvelope, anthropicRequest, responsesEnvelope, responsesRequest } from "./compat.js";
import { Gateway, NoProviderError } from "./gateway.js";
import { ensureLocalProvider } from "./local-provider.js";
import { connectionDefinitions, credentialsEnvironment, validateCredentials } from "./provider-connections.js";
import { configuredProviders } from "./providers.js";
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
    if (request.method === "GET" && url.pathname === "/") {
      return html(response, 200, auth.authorized(request) ? dashboardHtml : loginHtml);
    }
    if (!auth.authorized(request)) {
      return json(response, 401, { error: { message: "Log in to the harness", type: "authentication_error" } });
    }
    if (request.method === "POST" && url.pathname === "/auth/logout") {
      auth.logout(request, response);
      return json(response, 200, { ok: true });
    }
    if (request.method === "GET" && url.pathname === "/auth/me") {
      return json(response, 200, { authenticated: true });
    }
    if (request.method === "GET" && url.pathname === "/health") {
      return json(response, 200, {
        status: providers.length && auth.configured() ? "ok" : "unconfigured",
        providers: providers.map((provider) => ({ id: provider.id, models: provider.models.length, quotaKind: provider.quotaKind, dataMayTrain: provider.dataMayTrain })),
      });
    }
    if (request.method === "GET" && url.pathname === "/v1/providers") {
      const active = new Set(providers.map((provider) => provider.id));
      return json(response, 200, {
        data: [
          { id: "ollama", label: "Local Ollama", description: localProvider.message, connected: active.has("ollama"), managed: true, fields: [], runtime: gateway.runtime.get("ollama") ?? null, catalog: catalog.get("ollama") },
          ...connectionDefinitions.map((definition) => ({ ...definition, connected: active.has(definition.id), fields: definition.fields.map(({ env, label, secret }) => ({ env, label, secret })), runtime: gateway.runtime.get(definition.id) ?? null, catalog: catalog.get(definition.id) })),
        ],
      });
    }
    if (request.method === "GET" && url.pathname === "/v1/usage") {
      const days = Math.max(1, Math.min(365, Number(url.searchParams.get("days") ?? 30)));
      const since = new Date(Date.now() - days * 86_400_000).toISOString();
      return json(response, 200, { since, data: store.usageSummary(since) });
    }
    const providerMatch = /^\/v1\/providers\/([a-z0-9-]+)$/.exec(url.pathname);
    if (request.method === "POST" && providerMatch?.[1]) {
      const body = await readJson<{ credentials?: unknown }>(request);
      const credentials = validateCredentials(providerMatch[1], body.credentials);
      vault.set(providerMatch[1], credentials);
      refreshProviders();
      const connected = providers.find((provider) => provider.id === providerMatch[1]);
      if (connected) await catalog.refreshProvider(connected);
      return json(response, 200, { id: providerMatch[1], connected: true });
    }
    if (request.method === "DELETE" && providerMatch?.[1]) {
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
      const result = await gateway.complete(responsesRequest(body), request.headers);
      const envelope = await result.response.json() as Record<string, unknown>;
      recordKnownUsage(envelope, result, "responses");
      response.setHeader("x-harness-provider", result.candidate.provider.id);
      if (result.cacheHit) response.setHeader("x-harness-cache", "hit");
      return json(response, 200, responsesEnvelope(envelope));
    }
    if (request.method === "POST" && url.pathname === "/v1/messages") {
      const body = await readJson<Record<string, unknown>>(request);
      if (body.model && body.model !== "auto") return invalid(response, "The harness exposes only model=auto");
      if (body.stream === true) return invalid(response, "Streaming Anthropic compatibility is not enabled yet");
      const result = await gateway.complete(anthropicRequest(body), request.headers);
      const envelope = await result.response.json() as Record<string, unknown>;
      recordKnownUsage(envelope, result, "anthropic");
      response.setHeader("x-harness-provider", result.candidate.provider.id);
      if (result.cacheHit) response.setHeader("x-harness-cache", "hit");
      return json(response, 200, anthropicEnvelope(envelope));
    }
    if (request.method === "POST" && url.pathname === "/v1/embeddings") {
      const body = await readJson<Record<string, unknown>>(request);
      const result = await specializedJson("embeddings", providers, body, requestTimeoutMs);
      response.setHeader("x-harness-provider", result.providerId);
      return pipeResponse(response, result.response);
    }
    if (request.method === "POST" && url.pathname === "/v1/images/generations") {
      const body = await readJson<Record<string, unknown>>(request);
      const result = await specializedJson("images", providers, body, requestTimeoutMs);
      response.setHeader("x-harness-provider", result.providerId);
      return pipeResponse(response, result.response);
    }
    if (request.method === "POST" && url.pathname === "/v1/audio/transcriptions") {
      const raw = await readBuffer(request);
      const form = await new Request("http://localhost", { method: "POST", headers: { "content-type": request.headers["content-type"] ?? "" }, body: new Uint8Array(raw) }).formData();
      const result = await specializedTranscription(providers, form, requestTimeoutMs);
      response.setHeader("x-harness-provider", result.providerId);
      return pipeResponse(response, result.response);
    }
    if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
      const body = await readJson<ChatRequest>(request);
      if (!Array.isArray(body.messages)) return invalid(response, "messages must be an array");
      if (body.model && body.model !== "auto") return invalid(response, "The harness exposes only model=auto");
      const result = await gateway.complete({ ...body, model: "auto" }, request.headers);
      void recordDirectUsage(result.response.clone(), result.candidate.provider.id, result.candidate.model.id, result.latencyMs, result.cacheHit ?? false, store);
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
      return json(response, 202, publicRun(agent.create(objective)));
    }
    if (request.method === "GET" && url.pathname === "/v1/runs") {
      return json(response, 200, { data: store.listRuns(Number(url.searchParams.get("limit") ?? 50)).map(publicRun) });
    }
    const runMatch = /^\/v1\/runs\/([0-9a-f-]+)$/.exec(url.pathname);
    if (request.method === "GET" && runMatch?.[1]) {
      const run = store.getRun(runMatch[1]);
      return run ? json(response, 200, publicRun(run)) : json(response, 404, { error: { message: "Run not found", type: "not_found" } });
    }
    const runActionMatch = /^\/v1\/runs\/([0-9a-f-]+)\/(cancel|resume)$/.exec(url.pathname);
    if (request.method === "POST" && runActionMatch?.[1] && runActionMatch[2]) {
      const run = runActionMatch[2] === "cancel" ? agent.cancel(runActionMatch[1]) : agent.resume(runActionMatch[1]);
      return run ? json(response, 200, publicRun(run)) : json(response, 404, { error: { message: "Run not found", type: "not_found" } });
    }
    const feedbackMatch = /^\/v1\/runs\/([0-9a-f-]+)\/feedback$/.exec(url.pathname);
    if (request.method === "POST" && feedbackMatch?.[1]) {
      const run = store.getRun(feedbackMatch[1]);
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
  applyFeedbackAdjustments();
}

function applyFeedbackAdjustments(): void {
  for (const [providerId, adjustment] of Object.entries(store.providerFeedbackAdjustments())) {
    const previous = gateway.runtime.get(providerId) ?? { failures: 0, unavailableUntil: 0 };
    gateway.runtime.set(providerId, { ...previous, qualityAdjustment: adjustment });
  }
}

applyFeedbackAdjustments();

async function recordDirectUsage(response: Response, providerId: string, modelId: string, latencyMs: number, cacheHit: boolean, targetStore: Store): Promise<void> {
  if (!response.headers.get("content-type")?.includes("json")) return;
  try {
    const body = await response.json() as { usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } };
    targetStore.recordUsage({
      providerId, modelId, endpoint: cacheHit ? "chat:cache" : "chat", status: response.status, latencyMs,
      promptTokens: cacheHit ? 0 : body.usage?.prompt_tokens ?? 0,
      completionTokens: cacheHit ? 0 : body.usage?.completion_tokens ?? 0,
      totalTokens: cacheHit ? 0 : body.usage?.total_tokens ?? 0,
    });
  } catch {
    // Streaming and non-JSON provider responses cannot be counted here.
  }
}

function recordKnownUsage(envelope: Record<string, unknown>, result: Awaited<ReturnType<Gateway["complete"]>>, endpoint: string): void {
  const usage = envelope.usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;
  store.recordUsage({
    providerId: result.candidate.provider.id, modelId: result.candidate.model.id, endpoint: result.cacheHit ? `${endpoint}:cache` : endpoint,
    promptTokens: result.cacheHit ? 0 : usage?.prompt_tokens ?? 0, completionTokens: result.cacheHit ? 0 : usage?.completion_tokens ?? 0,
    totalTokens: result.cacheHit ? 0 : usage?.total_tokens ?? 0, status: result.response.status, latencyMs: result.latencyMs,
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
  response.writeHead(status, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" });
  response.end(value);
}

function pipeResponse(response: ServerResponse, upstream: Response): void {
  response.statusCode = upstream.status;
  response.setHeader("content-type", upstream.headers.get("content-type") ?? "application/json");
  if (upstream.body) Readable.fromWeb(upstream.body as never).pipe(response);
  else response.end();
}
