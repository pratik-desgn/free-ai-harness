import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Store } from "./store.js";

const COOKIE_NAME = "harness_session";

export class Auth {
  constructor(
    private readonly store: Store,
    private readonly loginPassword: string | undefined,
    private readonly apiKey: string | undefined,
    private readonly sessionDays: number,
  ) {}

  configured(): boolean {
    return Boolean(this.loginPassword || this.apiKey);
  }

  authorized(request: IncomingMessage): boolean {
    const bearer = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (bearer && this.apiKey && secureEqual(bearer, this.apiKey)) return true;
    const session = parseCookies(request.headers.cookie)[COOKIE_NAME];
    return session ? this.store.validSession(hashToken(session)) : false;
  }

  login(password: string, response: ServerResponse): boolean {
    if (!this.loginPassword || !secureEqual(password, this.loginPassword)) return false;
    const token = randomBytes(32).toString("base64url");
    const maxAge = Math.max(1, this.sessionDays) * 24 * 60 * 60;
    this.store.createSession(hashToken(token), Date.now() + maxAge * 1_000);
    response.setHeader("set-cookie", `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`);
    return true;
  }

  logout(request: IncomingMessage, response: ServerResponse): void {
    const session = parseCookies(request.headers.cookie)[COOKIE_NAME];
    if (session) this.store.deleteSession(hashToken(session));
    response.setHeader("set-cookie", `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(
    header.split(";").map((part) => {
      const [name = "", ...value] = part.trim().split("=");
      return [name, value.join("=")];
    }),
  );
}
