import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { Store } from "./store.js";

export class CredentialVault {
  private readonly key: Buffer;

  constructor(private readonly store: Store, keyMaterial: string) {
    if (!keyMaterial) throw new Error("HARNESS_VAULT_KEY is required");
    this.key = /^[0-9a-f]{64}$/i.test(keyMaterial)
      ? Buffer.from(keyMaterial, "hex")
      : createHash("sha256").update(keyMaterial).digest();
  }

  set(providerId: string, credentials: Record<string, string>): void {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(providerId));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(credentials), "utf8"), cipher.final()]);
    this.store.setProviderSecret(providerId, ciphertext.toString("base64"), iv.toString("base64"), cipher.getAuthTag().toString("base64"));
  }

  all(): Record<string, Record<string, string>> {
    return Object.fromEntries(this.store.providerSecrets().map((row) => [row.providerId, this.decrypt(row)]));
  }

  connected(): Set<string> {
    return new Set(this.store.providerSecrets().map((row) => row.providerId));
  }

  delete(providerId: string): void {
    this.store.deleteProviderSecret(providerId);
  }

  setForUser(userId: string, providerId: string, credentials: Record<string, string>): void {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(`${userId}:${providerId}`));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(credentials), "utf8"), cipher.final()]);
    this.store.setUserProviderSecret(userId, providerId, ciphertext.toString("base64"), iv.toString("base64"), cipher.getAuthTag().toString("base64"));
  }

  allForUser(userId: string): Record<string, Record<string, string>> {
    return Object.fromEntries(this.store.userProviderSecrets(userId).map((row) => [row.providerId, this.decrypt(row, userId)]));
  }

  connectedForUser(userId: string): Set<string> {
    return new Set(this.store.userProviderSecrets(userId).map((row) => row.providerId));
  }

  deleteForUser(userId: string, providerId: string): void {
    this.store.deleteUserProviderSecret(userId, providerId);
  }

  private decrypt(row: { providerId: string; ciphertext: string; iv: string; authTag: string }, userId?: string): Record<string, string> {
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(row.iv, "base64"));
    decipher.setAAD(Buffer.from(userId ? `${userId}:${row.providerId}` : row.providerId));
    decipher.setAuthTag(Buffer.from(row.authTag, "base64"));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(row.ciphertext, "base64")), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8")) as Record<string, string>;
  }
}
