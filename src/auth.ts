import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Store } from "./store.js";

const COOKIE_NAME = "harness_session";

export interface Principal {
  id: string;
  provider: "operator" | "puter";
  displayName: string;
}

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

  principal(request: IncomingMessage): Principal | undefined {
    const bearer = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (bearer && this.apiKey && secureEqual(bearer, this.apiKey)) return { id: "operator", provider: "operator", displayName: "Administrator" };
    const session = parseCookies(request.headers.cookie)[COOKIE_NAME];
    const userId = session ? this.store.sessionUser(hashToken(session)) : undefined;
    if (!userId) return undefined;
    if (userId === "operator") return { id: userId, provider: "operator", displayName: "Administrator" };
    const user = this.store.getUser(userId);
    return user ? { id: user.id, provider: "puter", displayName: user.displayName } : undefined;
  }

  authorized(request: IncomingMessage): boolean {
    return this.principal(request) !== undefined;
  }

  login(password: string, response: ServerResponse): boolean {
    if (!this.loginPassword || !secureEqual(password, this.loginPassword)) return false;
    this.setSession("operator", response);
    return true;
  }

  createUserSession(userId: string, response: ServerResponse): void {
    this.setSession(userId, response);
  }

  logout(request: IncomingMessage, response: ServerResponse): void {
    const session = parseCookies(request.headers.cookie)[COOKIE_NAME];
    if (session) this.store.deleteSession(hashToken(session));
    response.setHeader("set-cookie", `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  }

  private setSession(userId: string, response: ServerResponse): void {
    const token = randomBytes(32).toString("base64url");
    const maxAge = Math.max(1, this.sessionDays) * 24 * 60 * 60;
    this.store.createSession(hashToken(token), Date.now() + maxAge * 1_000, userId);
    response.setHeader("set-cookie", `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`);
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
