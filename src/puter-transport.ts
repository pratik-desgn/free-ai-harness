import type { ChatRequest, ProviderSpec } from "./types.js";

interface PuterEnvelope {
  success?: boolean;
  result?: {
    finish_reason?: string | null;
    index?: number;
    logprobs?: unknown;
    message?: Record<string, unknown>;
    usage?: PuterUsage;
  };
  error?: { code?: string; message?: string; status?: number } | string;
  code?: string;
  message?: string;
}

interface PuterUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  cached_tokens?: number;
}

/** Convert Puter's supported user-pays driver API into our OpenAI-compatible wire shape. */
export async function puterChatCompletion(
  provider: ProviderSpec,
  request: ChatRequest,
  timeoutMs: number,
  maxResponseBytes: number,
): Promise<Response> {
  if (!provider.apiKey) return puterError(401, "Puter authorization is missing", "token_auth_failed");
  const upstream = await fetch(`${provider.baseUrl}/drivers/call`, {
    method: "POST",
    headers: { "Content-Type": "text/plain;actually=json", ...provider.extraHeaders },
    body: JSON.stringify({
      interface: "puter-chat-completion",
      driver: "ai-chat",
      method: "complete",
      test_mode: false,
      args: request,
      auth_token: provider.apiKey,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const contentType = upstream.headers.get("content-type") ?? "";
  if (request.stream === true && contentType.includes("application/x-ndjson") && upstream.body) {
    return new Response(puterStream(upstream.body, String(request.model ?? "unknown")), {
      status: upstream.status,
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
    });
  }

  const text = await readLimited(upstream, maxResponseBytes);
  if (text === undefined) return puterError(502, "Puter response exceeded the safety limit", "upstream_too_large");
  let envelope: PuterEnvelope;
  try {
    envelope = JSON.parse(text) as PuterEnvelope;
  } catch {
    return puterError(502, "Puter returned an invalid response", "invalid_upstream_response");
  }
  if (!upstream.ok || envelope.success === false || envelope.error) {
    const code = errorCode(envelope);
    const status = upstream.ok ? statusForCode(code, envelope) : upstream.status;
    return puterError(status, errorMessage(envelope), code);
  }
  const result = envelope.result;
  if (!result?.message) return puterError(502, "Puter returned no assistant message", "invalid_upstream_response");
  const usage = openAIUsage(result.usage);
  return Response.json({
    id: `puter-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1_000),
    model: request.model,
    choices: [{
      index: result.index ?? 0,
      message: result.message,
      finish_reason: result.finish_reason ?? "stop",
      logprobs: result.logprobs ?? null,
    }],
    ...(usage ? { usage } : {}),
  });
}

function puterStream(body: ReadableStream<Uint8Array>, model: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = body.getReader();
      let buffer = "";
      let roleSent = false;
      const emit = (value: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
      const handle = (line: string) => {
        if (!line.trim()) return;
        const part = JSON.parse(line) as { type?: string; text?: string; usage?: PuterUsage; error?: unknown };
        if (part.error) {
          emit({ error: part.error });
          return;
        }
        if (part.type === "text") {
          emit({
            id: "puter-stream",
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1_000),
            model,
            choices: [{ index: 0, delta: { ...(roleSent ? {} : { role: "assistant" }), content: part.text ?? "" }, finish_reason: null }],
          });
          roleSent = true;
        } else if (part.type === "usage") {
          const usage = openAIUsage(part.usage);
          if (usage) emit({ id: "puter-stream", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1_000), model, choices: [], usage });
        }
      };
      try {
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          buffer += decoder.decode(item.value, { stream: true });
          let newline = buffer.indexOf("\n");
          while (newline >= 0) {
            handle(buffer.slice(0, newline));
            buffer = buffer.slice(newline + 1);
            newline = buffer.indexOf("\n");
          }
        }
        buffer += decoder.decode();
        handle(buffer);
        emit({ id: "puter-stream", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1_000), model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        reader.releaseLock();
      }
    },
    cancel(reason) {
      return body.cancel(reason);
    },
  });
}

function openAIUsage(usage?: PuterUsage): Record<string, number> | undefined {
  if (!usage) return undefined;
  const prompt = usage.prompt_tokens ?? 0;
  const completion = usage.completion_tokens ?? 0;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

async function readLimited(response: Response, limit: number): Promise<string | undefined> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let output = "";
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
      output += decoder.decode(item.value, { stream: true });
    }
    return output + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function errorCode(envelope: PuterEnvelope): string {
  if (typeof envelope.error === "object" && envelope.error?.code) return envelope.error.code;
  return envelope.code ?? "puter_error";
}

function errorMessage(envelope: PuterEnvelope): string {
  if (typeof envelope.error === "string") return envelope.error;
  return envelope.error?.message ?? envelope.message ?? "Puter rejected the request";
}

function statusForCode(code: string, envelope: PuterEnvelope): number {
  if (typeof envelope.error === "object" && Number.isInteger(envelope.error?.status)) return Number(envelope.error.status);
  if (/token|auth|unauthor/i.test(code)) return 401;
  if (/fund|payment/i.test(code)) return 402;
  if (/limit|quota|rate/i.test(code)) return 429;
  return 502;
}

function puterError(status: number, message: string, code: string): Response {
  return Response.json({ error: { message, type: "puter_error", code } }, { status });
}
