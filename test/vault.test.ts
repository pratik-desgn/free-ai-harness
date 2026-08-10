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
