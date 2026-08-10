import type { ChatMessage, ChatRequest } from "./types.js";

interface ChatEnvelope {
  id?: string;
  created?: number;
  model?: string;
  choices?: Array<{ finish_reason?: string; message?: ChatMessage & { tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export function responsesRequest(body: Record<string, unknown>): ChatRequest {
  const input = body.input;
  const messages: ChatMessage[] = typeof input === "string"
    ? [{ role: "user", content: input }]
    : Array.isArray(input)
      ? input.map((item) => normalizeMessage(item))
      : [];
  return {
    model: "auto",
    messages,
    stream: false,
    ...(Array.isArray(body.tools) ? { tools: body.tools } : {}),
    ...(typeof body.max_output_tokens === "number" ? { max_tokens: body.max_output_tokens } : {}),
  };
}

export function responsesEnvelope(chat: ChatEnvelope): Record<string, unknown> {
  const message = chat.choices?.[0]?.message;
  const text = typeof message?.content === "string" ? message.content : JSON.stringify(message?.content ?? "");
  return {
    id: chat.id ?? `resp_${crypto.randomUUID().replaceAll("-", "")}`,
    object: "response",
    created_at: chat.created ?? Math.floor(Date.now() / 1_000),
    status: "completed",
    model: "auto",
    output: [{
      id: `msg_${crypto.randomUUID().replaceAll("-", "")}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
    }],
    usage: {
      input_tokens: chat.usage?.prompt_tokens ?? 0,
      output_tokens: chat.usage?.completion_tokens ?? 0,
      total_tokens: chat.usage?.total_tokens ?? 0,
    },
  };
}

export function anthropicRequest(body: Record<string, unknown>): ChatRequest {
  const inputMessages = Array.isArray(body.messages) ? body.messages : [];
  const messages: ChatMessage[] = [];
  if (typeof body.system === "string") messages.push({ role: "system", content: body.system });
  for (const item of inputMessages) {
    if (!item || typeof item !== "object") continue;
    const source = item as { role?: string; content?: unknown };
    if (Array.isArray(source.content)) {
      for (const block of source.content) {
        if (block && typeof block === "object" && (block as { type?: string }).type === "tool_result") {
          const result = block as { tool_use_id?: string; content?: unknown };
          messages.push({ role: "tool", tool_call_id: result.tool_use_id ?? "unknown", content: stringifyContent(result.content) });
        } else {
          messages.push({ role: source.role === "assistant" ? "assistant" : "user", content: [block] });
        }
      }
    } else {
      messages.push({ role: source.role === "assistant" ? "assistant" : "user", content: source.content ?? "" });
    }
  }
  const tools = Array.isArray(body.tools)
    ? body.tools.map((tool) => {
        const value = tool as { name?: string; description?: string; input_schema?: unknown };
        return { type: "function", function: { name: value.name, description: value.description, parameters: value.input_schema } };
      })
    : undefined;
  return {
    model: "auto",
    messages,
    stream: false,
    ...(tools ? { tools } : {}),
    ...(typeof body.max_tokens === "number" ? { max_tokens: body.max_tokens } : {}),
  };
}

export function anthropicEnvelope(chat: ChatEnvelope): Record<string, unknown> {
  const message = chat.choices?.[0]?.message;
  const content: Array<Record<string, unknown>> = [];
  if (typeof message?.content === "string" && message.content) content.push({ type: "text", text: message.content });
  for (const call of message?.tool_calls ?? []) {
    let input: unknown;
    try { input = JSON.parse(call.function.arguments); } catch { input = { raw: call.function.arguments }; }
    content.push({ type: "tool_use", id: call.id, name: call.function.name, input });
  }
  return {
    id: chat.id ?? `msg_${crypto.randomUUID().replaceAll("-", "")}`,
    type: "message",
    role: "assistant",
    model: "auto",
    content,
    stop_reason: message?.tool_calls?.length ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: { input_tokens: chat.usage?.prompt_tokens ?? 0, output_tokens: chat.usage?.completion_tokens ?? 0 },
  };
}

function normalizeMessage(item: unknown): ChatMessage {
  if (!item || typeof item !== "object") return { role: "user", content: String(item ?? "") };
  const value = item as { role?: string; content?: unknown };
  const role = ["system", "developer", "user", "assistant", "tool"].includes(value.role ?? "")
    ? value.role as ChatMessage["role"]
    : "user";
  return { role, content: value.content ?? "" };
}

function stringifyContent(content: unknown): string {
  if (typeof content === "string") return content;
  return JSON.stringify(content ?? "");
}
