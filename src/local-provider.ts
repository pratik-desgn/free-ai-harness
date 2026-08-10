import { spawn } from "node:child_process";

export async function ensureLocalProvider(env: NodeJS.ProcessEnv = process.env): Promise<{ available: boolean; started: boolean; message: string }> {
  if (env.OLLAMA_ENABLED === "false") return { available: false, started: false, message: "Local provider disabled" };
  const baseUrl = env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434/v1";
  const healthUrl = baseUrl.replace(/\/v1\/?$/, "/api/tags");
  if (await responds(healthUrl)) return { available: true, started: false, message: "Local provider ready" };

  try {
    const child = spawn("ollama", ["serve"], { detached: true, stdio: "ignore", env });
    child.unref();
  } catch (error) {
    return { available: false, started: false, message: `Could not start Ollama: ${error instanceof Error ? error.message : String(error)}` };
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (await responds(healthUrl)) return { available: true, started: true, message: "Started local Ollama provider" };
  }
  return { available: false, started: true, message: "Ollama was started but did not become ready" };
}

async function responds(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(800) });
    return response.ok;
  } catch {
    return false;
  }
}
