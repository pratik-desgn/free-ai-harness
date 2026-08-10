import { createHash } from "node:crypto";

const PUTER_MODELS_URL = "https://api.puter.com/puterai/openai/v1/models";

export interface PuterIdentity {
  id: string;
  externalId: string;
  displayName: string;
}

export async function verifyPuterToken(token: string, requestedDisplayName?: string): Promise<PuterIdentity> {
  const normalized = token.trim();
  if (normalized.length < 20 || normalized.length > 8_192) throw new Error("Invalid Puter authorization");
  const response = await fetch(PUTER_MODELS_URL, {
    headers: { Authorization: `Bearer ${normalized}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(response.status === 401 || response.status === 403 ? "Puter authorization was rejected" : `Puter is temporarily unavailable (HTTP ${response.status})`);
  }
  await response.body?.cancel();
  const externalId = createHash("sha256").update(normalized).digest("hex");
  const cleanedName = requestedDisplayName?.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80);
  return { id: `puter:${externalId}`, externalId, displayName: cleanedName || "AI user" };
}
