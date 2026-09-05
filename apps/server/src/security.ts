import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export type TokenKind = "cli" | "device" | "response" | "enrollment";

export class TokenAuthority {
  public constructor(private readonly key: Buffer) {
    if (key.byteLength < 32) throw new Error("Token hashing key must contain at least 32 bytes");
  }

  public issue(kind: TokenKind): { plaintext: string; digest: string } {
    const plaintext = `relay_${kind}_${randomBytes(32).toString("base64url")}`;
    return { plaintext, digest: this.digest(plaintext, kind) };
  }

  public derive(kind: TokenKind, context: string): { plaintext: string; digest: string } {
    const entropy = createHmac("sha256", this.key)
      .update("relay:derived-token:v1\0", "utf8")
      .update(kind, "utf8")
      .update("\0", "utf8")
      .update(context, "utf8")
      .digest("base64url");
    const plaintext = `relay_${kind}_${entropy}`;
    return { plaintext, digest: this.digest(plaintext, kind) };
  }

  public digest(value: string, kind: TokenKind): string {
    return createHmac("sha256", this.key)
      .update("relay:token:v1\0", "utf8")
      .update(kind, "utf8")
      .update("\0", "utf8")
      .update(value, "utf8")
      .digest("base64url");
  }

  public verify(value: string, expectedDigest: string, kind: TokenKind = "cli"): boolean {
    const actual = Buffer.from(this.digest(value, kind), "utf8");
    const expected = Buffer.from(expectedDigest, "utf8");
    return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
  }
}

export class SecretBox {
  private constructor(private readonly key: Buffer) {}

  public static fromBase64(value: string): SecretBox {
    const key = Buffer.from(value, "base64");
    if (key.byteLength !== 32) throw new Error("Encryption key must be 32 bytes encoded as base64");
    return new SecretBox(key);
  }

  public seal(plaintext: string, context: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(context, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ["v1", nonce.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
  }

  public open(value: string, context: string): string {
    const [version, nonceValue, tagValue, ciphertextValue, extra] = value.split(".");
    if (version !== "v1" || !nonceValue || !tagValue || ciphertextValue === undefined || extra) {
      throw new Error("Invalid ciphertext envelope");
    }
    const nonce = Buffer.from(nonceValue, "base64url");
    const tag = Buffer.from(tagValue, "base64url");
    const ciphertext = Buffer.from(ciphertextValue, "base64url");
    if (nonce.byteLength !== 12 || tag.byteLength !== 16) throw new Error("Invalid ciphertext envelope");
    const decipher = createDecipheriv("aes-256-gcm", this.key, nonce);
    decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  }
}
