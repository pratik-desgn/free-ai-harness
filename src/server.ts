import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { AgentEngine } from "./agent.js";
import { Auth } from "./auth.js";
import { Gateway, NoProviderError } from "./gateway.js";
import { configuredProviders } from "./providers.js";
import { Store } from "./store.js";
import { builtInTools } from "./tools.js";
import type { ChatRequest } from "./types.js";
import { dashboardHtml, loginHtml } from "./ui.js";

const port = Number(process.env.HARNESS_PORT ?? 8787);
const dataDirectory = resolve(process.env.HARNESS_DATA_DIR ?? ".harness");
const providers = configuredProviders();
const store = new Store(resolve(dataDirectory, "state.db"));
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
);
const agent = new AgentEngine(gateway, store, builtInTools(), Number(process.env.HARNESS_MAX_AGENT_STEPS ?? 12));

store.pruneSessions();
agent.resumePersisted();

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
    if (request.method === "GET" && url.pathname === "/v1/models") {
      return json(response, 200, { object: "list", data: [{ id: "auto", object: "model", owned_by: "free-ai-harness" }] });
    }
    if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
      const body = await readJson<ChatRequest>(request);
      if (!Array.isArray(body.messages)) return invalid(response, "messages must be an array");
      if (body.model && body.model !== "auto") return invalid(response, "The harness exposes only model=auto");
      const result = await gateway.complete({ ...body, model: "auto" }, request.headers);
      response.statusCode = result.response.status;
      response.setHeader("content-type", result.response.headers.get("content-type") ?? "application/json");
      response.setHeader("x-harness-provider", result.candidate.provider.id);
      response.setHeader("x-harness-model", result.candidate.model.id);
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
    const runMatch = /^\/v1\/runs\/([0-9a-f-]+)$/.exec(url.pathname);
    if (request.method === "GET" && runMatch?.[1]) {
      const run = store.getRun(runMatch[1]);
      return run ? json(response, 200, publicRun(run)) : json(response, 404, { error: { message: "Run not found", type: "not_found" } });
    }
    return json(response, 404, { error: { message: "Not found", type: "invalid_request_error" } });
  } catch (error) {
    const status = error instanceof NoProviderError ? 503 : error instanceof SyntaxError ? 400 : 500;
    return json(response, status, { error: { message: error instanceof Error ? error.message : String(error), type: "harness_error" } });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`free-ai-harness listening on http://127.0.0.1:${port} with ${providers.length} provider(s)`);
  if (!auth.configured()) console.warn("Set HARNESS_LOGIN_PASSWORD before exposing the service");
});

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 10 * 1024 * 1024) throw new SyntaxError("Request body exceeds 10 MiB");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
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
