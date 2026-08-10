import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Store } from "../src/store.js";
import { CredentialVault } from "../src/vault.js";

test("provider credentials are encrypted at rest and can be disconnected", () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-vault-"));
  const path = join(directory, "state.db");
  try {
    const store = new Store(path);
    const vault = new CredentialVault(store, "a".repeat(64));
    vault.set("groq", { GROQ_API_KEY: "secret-provider-key" });
    assert.equal(vault.all().groq?.GROQ_API_KEY, "secret-provider-key");
    assert.equal(readFileSync(path).includes(Buffer.from("secret-provider-key")), false);
    vault.delete("groq");
    assert.equal(vault.connected().has("groq"), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("user credentials are encrypted and isolated", () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-user-vault-"));
  const path = join(directory, "state.db");
  try {
    const vault = new CredentialVault(new Store(path), "b".repeat(64));
    vault.setForUser("alice", "puter", { PUTER_AUTH_TOKEN: "alice-secret-token" });
    vault.setForUser("bob", "puter", { PUTER_AUTH_TOKEN: "bob-secret-token" });
    assert.equal(vault.allForUser("alice").puter?.PUTER_AUTH_TOKEN, "alice-secret-token");
    assert.equal(vault.allForUser("bob").puter?.PUTER_AUTH_TOKEN, "bob-secret-token");
    assert.equal(readFileSync(path).includes(Buffer.from("alice-secret-token")), false);
    vault.deleteForUser("alice", "puter");
    assert.equal(vault.connectedForUser("alice").has("puter"), false);
    assert.equal(vault.connectedForUser("bob").has("puter"), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("user ciphertext cannot be decrypted under another user or vault key", () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-vault-boundary-"));
  const path = join(directory, "state.db");
  try {
    const store = new Store(path);
    const aliceVault = new CredentialVault(store, "c".repeat(64));
    aliceVault.setForUser("alice", "puter", { PUTER_AUTH_TOKEN: "alice-secret" });

    assert.deepEqual(aliceVault.allForUser("bob"), {});
    assert.throws(() => new CredentialVault(store, "d".repeat(64)).allForUser("alice"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
