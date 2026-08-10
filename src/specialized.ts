import type { ProviderSpec } from "./types.js";

interface Target {
  providerId: string;
  model: string;
  path: string;
}

const targets: Record<string, Target[]> = {
  embeddings: [
    { providerId: "ollama", model: "nomic-embed-text", path: "/embeddings" },
    { providerId: "gemini", model: "text-embedding-004", path: "/embeddings" },
    { providerId: "cloudflare", model: "@cf/baai/bge-base-en-v1.5", path: "/embeddings" },
    { providerId: "mistral", model: "mistral-embed", path: "/embeddings" },
  ],
  images: [
    { providerId: "cloudflare", model: "@cf/black-forest-labs/flux-1-schnell", path: "" },
  ],
  transcription: [
    { providerId: "groq", model: "whisper-large-v3-turbo", path: "/audio/transcriptions" },
  ],
};

export async function specializedJson(
  kind: "embeddings" | "images",
  providers: ProviderSpec[],
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<{ response: Response; providerId: string; modelId: string }> {
  const attempts: string[] = [];
  for (const target of targets[kind] ?? []) {
    const provider = providers.find((candidate) => candidate.id === target.providerId);
    if (!provider) continue;
    try {
      if (kind === "images" && provider.id === "cloudflare") {
        const response = await cloudflareImage(provider, target.model, body, timeoutMs);
        if (response.ok) return { response, providerId: provider.id, modelId: target.model };
        attempts.push(`${provider.id}: HTTP ${response.status}`);
        await response.body?.cancel();
        continue;
      }
      const response = await fetch(`${provider.baseUrl}${target.path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${provider.apiKey}`, "Content-Type": "application/json", ...provider.extraHeaders },
        body: JSON.stringify({ ...body, model: target.model }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) return { response, providerId: provider.id, modelId: target.model };
      attempts.push(`${provider.id}: HTTP ${response.status}`);
      await response.body?.cancel();
    } catch (error) {
      attempts.push(`${provider.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`No ${kind} provider succeeded${attempts.length ? ` (${attempts.join(", ")})` : ""}`);
}

async function cloudflareImage(
  provider: ProviderSpec,
  modelId: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<Response> {
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) throw new Error("prompt is required");
  const input: Record<string, unknown> = { prompt };
  if (typeof body.seed === "number") input.seed = body.seed;
  if (typeof body.steps === "number") input.steps = Math.max(1, Math.min(8, Math.floor(body.steps)));

  const response = await fetch(`${cloudflareAccountBase(provider.baseUrl)}/ai/run/${modelId}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${provider.apiKey}`, "Content-Type": "application/json", ...provider.extraHeaders },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) return response;

  const envelope = await response.json() as { image?: unknown; result?: { image?: unknown } };
  const image = envelope.result?.image ?? envelope.image;
  if (typeof image !== "string" || !image) {
    return Response.json({ error: { message: "Cloudflare returned no image", type: "upstream_error" } }, { status: 502 });
  }
  return Response.json({ created: Math.floor(Date.now() / 1000), data: [{ b64_json: image }] });
}

export function cloudflareAccountBase(baseUrl: string): string {
  const marker = "/ai/v1";
  if (!baseUrl.endsWith(marker)) throw new Error("Invalid Cloudflare Workers AI base URL");
  return baseUrl.slice(0, -marker.length);
}

export async function specializedTranscription(
  providers: ProviderSpec[],
  form: FormData,
  timeoutMs: number,
): Promise<{ response: Response; providerId: string; modelId: string }> {
  const attempts: string[] = [];
  for (const target of targets.transcription ?? []) {
    const provider = providers.find((candidate) => candidate.id === target.providerId);
    if (!provider) continue;
    const outgoing = new FormData();
    for (const [name, value] of form.entries()) if (name !== "model") outgoing.append(name, value);
    outgoing.set("model", target.model);
    try {
      const response = await fetch(`${provider.baseUrl}${target.path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${provider.apiKey}`, ...provider.extraHeaders },
        body: outgoing,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) return { response, providerId: provider.id, modelId: target.model };
      attempts.push(`${provider.id}: HTTP ${response.status}`);
      await response.body?.cancel();
    } catch (error) {
      attempts.push(`${provider.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`No transcription provider succeeded${attempts.length ? ` (${attempts.join(", ")})` : ""}`);
}
