import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Auth } from "../src/auth.js";
import { Store } from "../src/store.js";

function request(headers: Record<string, string> = {}): IncomingMessage {
  return { headers } as IncomingMessage;
}

function response(): ServerResponse & { headers: Map<string, string | number | readonly string[]> } {
  const headers = new Map<string, string | number | readonly string[]>();
  return {
    headers,
    setHeader(name: string, value: string | number | readonly string[]) {
      headers.set(name.toLowerCase(), value);
      return this;
    },
  } as unknown as ServerResponse & { headers: Map<string, string | number | readonly string[]> };
}

test("password sessions authenticate the operator and logout invalidates the server-side session", () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-auth-"));
  try {
    const store = new Store(join(directory, "state.db"));
    const auth = new Auth(store, "correct horse battery staple", undefined, 7);
    const loginResponse = response();

    assert.equal(auth.login("wrong", loginResponse), false);
    assert.equal(loginResponse.headers.has("set-cookie"), false);
    assert.equal(auth.login("correct horse battery staple", loginResponse), true);

    const setCookie = String(loginResponse.headers.get("set-cookie"));
    assert.match(setCookie, /^harness_session=[A-Za-z0-9_-]+;/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.match(setCookie, /Path=\//);
    assert.match(setCookie, /Max-Age=604800/);
    const cookie = setCookie.split(";", 1)[0]!;
    assert.deepEqual(auth.principal(request({ cookie })), {
      id: "operator", provider: "operator", displayName: "Administrator",
    });

    const logoutResponse = response();
    auth.logout(request({ cookie }), logoutResponse);
    assert.equal(auth.principal(request({ cookie })), undefined);
    assert.match(String(logoutResponse.headers.get("set-cookie")), /Max-Age=0/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("bearer authentication requires an exact key and cannot impersonate a user", () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-bearer-"));
  try {
    const auth = new Auth(new Store(join(directory, "state.db")), undefined, "api-secret", 1);
    assert.equal(auth.configured(), true);
    assert.equal(auth.principal(request({ authorization: "Bearer api-secret-extra" })), undefined);
    assert.equal(auth.principal(request({ authorization: "Basic api-secret" })), undefined);
    assert.deepEqual(auth.principal(request({ authorization: "bEaReR api-secret" })), {
      id: "operator", provider: "operator", displayName: "Administrator",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("user sessions resolve only to an existing matching identity", () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-user-auth-"));
  try {
    const store = new Store(join(directory, "state.db"));
    const auth = new Auth(store, undefined, undefined, 1);
    store.upsertUser({ id: "puter:alice", provider: "puter", externalId: "alice", displayName: "Alice" });

    const userResponse = response();
    auth.createUserSession("puter:alice", userResponse);
    const userCookie = String(userResponse.headers.get("set-cookie")).split(";", 1)[0]!;
    assert.deepEqual(auth.principal(request({ cookie: userCookie })), {
      id: "puter:alice", provider: "puter", displayName: "Alice",
    });

    const missingResponse = response();
    auth.createUserSession("puter:deleted", missingResponse);
    const missingCookie = String(missingResponse.headers.get("set-cookie")).split(";", 1)[0]!;
    assert.equal(auth.principal(request({ cookie: missingCookie })), undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("production sessions and logout cookies carry the Secure attribute", () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-secure-cookie-"));
  try {
    const store = new Store(join(directory, "state.db"));
    const auth = new Auth(store, "password", undefined, 1, true);
    const loginResponse = response();
    assert.equal(auth.login("password", loginResponse), true);
    const setCookie = String(loginResponse.headers.get("set-cookie"));
    assert.match(setCookie, /; Secure$/);

    const cookie = setCookie.split(";", 1)[0]!;
    const logoutResponse = response();
    auth.logout(request({ cookie }), logoutResponse);
    assert.match(String(logoutResponse.headers.get("set-cookie")), /; Secure$/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
