import { lookup } from "node:dns/promises";
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { mkdirSync } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { dirname, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface AgentTool {
  definition: {
    type: "function";
    function: { name: string; description: string; parameters: Record<string, unknown> };
  };
  execute(argumentsJson: string): Promise<string>;
}

export interface BuiltInToolOptions {
  allowNetwork?: boolean;
  allowWorkspace?: boolean;
  allowExecution?: boolean;
  workspaceByteLimit?: number;
  workspaceFileLimit?: number;
}

export function builtInTools(workspaceRoot = resolve("workspace"), options: BuiltInToolOptions = {}): AgentTool[] {
  mkdirSync(workspaceRoot, { recursive: true });
  const tools: AgentTool[] = [
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
          name: "chess_square_color",
          description: "Determine whether a standard chessboard coordinate is a light or dark square.",
          parameters: { type: "object", properties: { square: { type: "string", pattern: "^[a-h][1-8]$" } }, required: ["square"], additionalProperties: false },
        },
      },
      async execute(argumentsJson) {
        const { square } = JSON.parse(argumentsJson) as { square?: string };
        if (!square || !/^[a-h][1-8]$/i.test(square)) throw new Error("square must be a1 through h8");
        const file = square.toLowerCase().charCodeAt(0) - 96;
        const rank = Number(square[1]);
        const color = (file + rank) % 2 === 0 ? "dark" : "light";
        return `${square.toLowerCase()} is a ${color} square. Rule: a1 is dark; coordinates with an even file-number plus rank are dark, and odd sums are light.`;
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
    {
      definition: {
        type: "function",
        function: {
          name: "web_search",
          description: "Search the public web and return result titles, URLs, and snippets.",
          parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
        },
      },
      async execute(argumentsJson) {
        const { query } = JSON.parse(argumentsJson) as { query?: string };
        if (!query?.trim()) throw new Error("query is required");
        const html = await getPublicUrl(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query.slice(0, 500))}`);
        return searchResults(html);
      },
    },
    {
      definition: {
        type: "function",
        function: {
          name: "list_files",
          description: "List files inside the managed workspace.",
          parameters: { type: "object", properties: { path: { type: "string" } }, additionalProperties: false },
        },
      },
      async execute(argumentsJson) {
        const { path = "." } = JSON.parse(argumentsJson) as { path?: string };
        const target = await safeExistingPath(workspaceRoot, path);
        const entries = await readdir(target, { withFileTypes: true });
        return entries.slice(0, 500).map((entry) => `${entry.isDirectory() ? "directory" : "file"}\t${entry.name}`).join("\n");
      },
    },
    {
      definition: {
        type: "function",
        function: {
          name: "read_file",
          description: "Read a UTF-8 file inside the managed workspace.",
          parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
        },
      },
      async execute(argumentsJson) {
        const { path } = JSON.parse(argumentsJson) as { path?: string };
        if (!path) throw new Error("path is required");
        return (await readFile(await safeExistingPath(workspaceRoot, path), "utf8")).slice(0, 1_000_000);
      },
    },
    {
      definition: {
        type: "function",
        function: {
          name: "write_file",
          description: "Create or replace a UTF-8 file inside the managed workspace.",
          parameters: {
            type: "object",
            properties: { path: { type: "string" }, content: { type: "string" } },
            required: ["path", "content"], additionalProperties: false,
          },
        },
      },
      async execute(argumentsJson) {
        const { path, content } = JSON.parse(argumentsJson) as { path?: string; content?: string };
        if (!path || typeof content !== "string") throw new Error("path and content are required");
        if (path.length > 500) throw new Error("Path exceeds 500 characters");
        if (content.length > 1_000_000) throw new Error("File exceeds 1 MB");
        const target = safePath(workspaceRoot, path);
        await mkdir(dirname(target), { recursive: true });
        await assertParentInside(workspaceRoot, target);
        const usage = await workspaceUsage(workspaceRoot);
        let previousBytes = 0;
        let targetExists = false;
        try {
          const previous = await lstat(target);
          if (previous.isSymbolicLink()) throw new Error("Refusing to replace a symlink");
          targetExists = true;
          previousBytes = previous.isFile() ? previous.size : 0;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const byteLimit = options.workspaceByteLimit ?? 50 * 1024 * 1024;
        const fileLimit = options.workspaceFileLimit ?? 1_000;
        if (usage.bytes - previousBytes + Buffer.byteLength(content) > byteLimit) throw new Error("Workspace storage quota exceeded");
        if (!targetExists && usage.files >= fileLimit) throw new Error("Workspace file-count quota exceeded");
        const handle = await open(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW, 0o600);
        try {
          await handle.writeFile(content, { encoding: "utf8" });
        } finally {
          await handle.close();
        }
        return `Wrote ${Buffer.byteLength(content)} bytes to ${relative(workspaceRoot, target)}`;
      },
    },
    {
      definition: {
        type: "function",
        function: {
          name: "run_tests",
          description: "Run the package test script inside a managed workspace project.",
          parameters: { type: "object", properties: { path: { type: "string" } }, additionalProperties: false },
        },
      },
      async execute(argumentsJson) {
        const { path = "." } = JSON.parse(argumentsJson) as { path?: string };
        const cwd = await safeExistingPath(workspaceRoot, path);
        const packageJson = JSON.parse(await readFile(resolve(cwd, "package.json"), "utf8")) as { scripts?: { test?: string } };
        if (!packageJson.scripts?.test) throw new Error("No package test script exists");
        try {
          const { stdout, stderr } = await execFileAsync("npm", ["test"], {
            cwd,
            timeout: 120_000,
            maxBuffer: 1_000_000,
            env: {
              PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
              CI: "true",
              NODE_ENV: "test",
              NO_PROXY: "*",
              HTTP_PROXY: "",
              HTTPS_PROXY: "",
            },
          });
          return `${stdout}\n${stderr}`.slice(-1_000_000);
        } catch (error) {
          const failure = error as Error & { stdout?: string; stderr?: string };
          return `Tests failed\n${failure.stdout ?? ""}\n${failure.stderr ?? failure.message}`.slice(-1_000_000);
        }
      },
    },
  ];
  const allowNetwork = options.allowNetwork !== false;
  const allowWorkspace = options.allowWorkspace !== false;
  const allowExecution = options.allowExecution !== false;
  return tools.filter((tool) => {
    const name = tool.definition.function.name;
    if (!allowNetwork && ["http_get", "web_search"].includes(name)) return false;
    if (!allowWorkspace && ["list_files", "read_file", "write_file", "run_tests"].includes(name)) return false;
    if (!allowExecution && name === "run_tests") return false;
    return true;
  });
}

async function workspaceUsage(root: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) {
        files += 1;
        bytes += (await lstat(path)).size;
      }
      if (files > 10_000) throw new Error("Workspace contains too many files");
    }
  }
  return { bytes, files };
}

async function getPublicUrl(input: string): Promise<string> {
  let url = new URL(input);
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const addresses = await assertPublicUrl(url);
    const response = await pinnedGet(url, addresses[0]!);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.location;
      if (!location) throw new Error(`Redirect ${response.status} had no location`);
      url = new URL(location, url);
      continue;
    }
    if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`);
    return response.body.toString("utf8");
  }
  throw new Error("Too many redirects");
}

async function assertPublicUrl(url: URL): Promise<Array<{ address: string; family: number }>> {
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only HTTP(S) URLs are allowed");
  if (url.username || url.password) throw new Error("Credentials in URLs are not allowed");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const literalFamily = isIP(hostname);
  const addresses = literalFamily ? [{ address: hostname, family: literalFamily }] : await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => privateAddress(address))) throw new Error("Private or local network targets are blocked");
  return addresses;
}

async function pinnedGet(url: URL, target: { address: string; family: number }): Promise<{ status: number; location?: string; body: Buffer }> {
  return new Promise((resolveRequest, rejectRequest) => {
    const absoluteDeadline = setTimeout(() => request.destroy(new Error("HTTP request exceeded its 30 second deadline")), 30_000);
    const requester = url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = requester({
      protocol: url.protocol,
      hostname: target.address,
      family: target.family,
      port: url.port || undefined,
      method: "GET",
      path: `${url.pathname}${url.search}`,
      servername: url.protocol === "https:" ? url.hostname : undefined,
      headers: { Host: url.host, Accept: "text/plain,text/html,application/json", "Accept-Encoding": "identity", "User-Agent": "free-ai-harness/0.1" },
    }, (response) => {
      const declaredLength = Number(response.headers["content-length"] ?? 0);
      if (declaredLength > 1_000_000) {
        response.destroy();
        rejectRequest(new Error("Response exceeds 1 MB"));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 1_000_000) response.destroy(new Error("Response exceeds 1 MB"));
        else chunks.push(chunk);
      });
      response.on("error", (error) => {
        clearTimeout(absoluteDeadline);
        rejectRequest(error);
      });
      response.on("end", () => {
        clearTimeout(absoluteDeadline);
        resolveRequest({
          status: response.statusCode ?? 500,
          ...(typeof response.headers.location === "string" ? { location: response.headers.location } : {}),
          body: Buffer.concat(chunks),
        });
      });
    });
    request.setTimeout(20_000, () => request.destroy(new Error("HTTP request timed out")));
    request.on("error", (error) => {
      clearTimeout(absoluteDeadline);
      rejectRequest(error);
    });
    request.on("close", () => clearTimeout(absoluteDeadline));
    request.end();
  });
}

function privateAddress(address: string): boolean {
  let normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized.startsWith("::ffff:")) normalized = mappedIpv4(normalized.slice(7));
  if (normalized === "::1" || normalized === "::" || normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  const match = /^(?:\d{1,3}\.){3}\d{1,3}$/.exec(normalized);
  if (!match) return false;
  const [a = 0, b = 0] = normalized.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168)) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

function mappedIpv4(value: string): string {
  if (value.includes(".")) return value;
  const parts = value.split(":");
  if (parts.length !== 2) return value;
  const high = Number.parseInt(parts[0] ?? "", 16);
  const low = Number.parseInt(parts[1] ?? "", 16);
  if (!Number.isInteger(high) || !Number.isInteger(low) || high < 0 || high > 0xffff || low < 0 || low > 0xffff) return value;
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

function safePath(root: string, requested: string): string {
  const target = resolve(root, requested);
  if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error("Path escapes the managed workspace");
  return target;
}

async function safeExistingPath(root: string, requested: string): Promise<string> {
  const target = safePath(root, requested);
  const resolvedRoot = await realpath(root);
  const resolvedTarget = await realpath(target);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${sep}`)) throw new Error("Symlink escapes the managed workspace");
  return resolvedTarget;
}

async function assertParentInside(root: string, target: string): Promise<void> {
  const resolvedRoot = await realpath(root);
  const resolvedParent = await realpath(dirname(target));
  if (resolvedParent !== resolvedRoot && !resolvedParent.startsWith(`${resolvedRoot}${sep}`)) throw new Error("Symlink escapes the managed workspace");
}

function searchResults(html: string): string {
  const results = [...html.matchAll(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)]
    .slice(0, 8)
    .map((match, index) => `${index + 1}. ${plainText(match[2] ?? "")}\n${decodeURIComponent(match[1] ?? "")}\n${plainText(match[3] ?? "")}`);
  return results.length ? results.join("\n\n") : plainText(html).slice(0, 8_000);
}

function plainText(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
}
