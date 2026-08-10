import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface AgentTool {
  definition: {
    type: "function";
    function: { name: string; description: string; parameters: Record<string, unknown> };
  };
  execute(argumentsJson: string): Promise<string>;
}

export function builtInTools(): AgentTool[] {
  return [
    {
      definition: {
        type: "function",
        function: {
          name: "current_time",
          description: "Get the current date and time in an IANA timezone.",
          parameters: {
            type: "object",
            properties: { timezone: { type: "string", description: "IANA timezone such as Asia/Kathmandu" } },
            required: ["timezone"],
            additionalProperties: false,
          },
        },
      },
      async execute(argumentsJson) {
        const { timezone } = JSON.parse(argumentsJson) as { timezone?: string };
        if (!timezone) throw new Error("timezone is required");
        return new Intl.DateTimeFormat("en-CA", { dateStyle: "full", timeStyle: "long", timeZone: timezone }).format(new Date());
      },
    },
    {
      definition: {
        type: "function",
        function: {
          name: "http_get",
          description: "Read a public HTTP or HTTPS URL. Private networks and localhost are blocked.",
          parameters: {
            type: "object",
            properties: { url: { type: "string" } },
            required: ["url"],
            additionalProperties: false,
          },
        },
      },
      async execute(argumentsJson) {
        const { url } = JSON.parse(argumentsJson) as { url?: string };
        if (!url) throw new Error("url is required");
        return getPublicUrl(url);
      },
    },
  ];
}

async function getPublicUrl(input: string): Promise<string> {
  let url = new URL(input);
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    await assertPublicUrl(url);
    const response = await fetch(url, {
      redirect: "manual",
      headers: { Accept: "text/plain,text/html,application/json", "User-Agent": "free-ai-harness/0.1" },
      signal: AbortSignal.timeout(20_000),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`Redirect ${response.status} had no location`);
      url = new URL(location, url);
      continue;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (declaredLength > 1_000_000) throw new Error("Response exceeds 1 MB");
    const text = await response.text();
    return text.slice(0, 1_000_000);
  }
  throw new Error("Too many redirects");
}

async function assertPublicUrl(url: URL): Promise<void> {
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only HTTP(S) URLs are allowed");
  if (url.username || url.password) throw new Error("Credentials in URLs are not allowed");
  const addresses = isIP(url.hostname) ? [{ address: url.hostname }] : await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => privateAddress(address))) throw new Error("Private or local network targets are blocked");
}

function privateAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::1" || normalized === "::" || normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  const match = /^(?:\d{1,3}\.){3}\d{1,3}$/.exec(normalized);
  if (!match) return false;
  const [a = 0, b = 0] = normalized.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}
