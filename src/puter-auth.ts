import { createHash } from "node:crypto";

const PUTER_MODELS_URL = "https://api.puter.com/puterai/openai/v1/models";
const PUTER_IDENTITY_URL = "https://api.puter.com/whoami";

export interface PuterIdentity {
  id: string;
  externalId: string;
  displayName: string;
}

export class PuterAuthError extends Error {
  constructor(message: string, readonly status: 401 | 502) {
    super(message);
    this.name = "PuterAuthError";
  }
}

export async function verifyPuterToken(token: string, requestedDisplayName?: string): Promise<PuterIdentity> {
  const normalized = token.trim();
  if (normalized.length < 20 || normalized.length > 8_192) throw new PuterAuthError("Invalid Puter authorization", 401);
  const request = (url: string) => fetch(url, { headers: { Authorization: `Bearer ${normalized}` }, signal: AbortSignal.timeout(15_000) });
  const [identityResponse, modelsResponse] = await Promise.all([request(PUTER_IDENTITY_URL), request(PUTER_MODELS_URL)]);
  const failed = [identityResponse, modelsResponse].find((response) => !response.ok);
  if (failed) {
    await Promise.allSettled([identityResponse.body?.cancel(), modelsResponse.body?.cancel()]);
    throw failed.status === 401 || failed.status === 403
      ? new PuterAuthError("Puter authorization was rejected", 401)
      : new PuterAuthError("Puter is temporarily unavailable", 502);
  }
  const puterUser = await identityResponse.json() as { uuid?: unknown; username?: unknown };
  await modelsResponse.body?.cancel();
  if (typeof puterUser.uuid !== "string" || !puterUser.uuid || puterUser.uuid.length > 200) throw new PuterAuthError("Puter returned an invalid user identity", 502);
  const externalId = puterUser.uuid;
  const opaqueId = createHash("sha256").update(`puter:${externalId}`).digest("hex");
  const suppliedName = typeof puterUser.username === "string" ? puterUser.username : requestedDisplayName;
  const cleanedName = suppliedName?.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80);
  return { id: `puter:${opaqueId}`, externalId, displayName: cleanedName || "AI user" };
}
