import { describe, expect, test } from "vitest";
import { SecretBox, TokenAuthority } from "./security.js";

const masterKey = Buffer.alloc(32, 7).toString("base64");

describe("TokenAuthority", () => {
  test("issues prefixed tokens and verifies only the matching value", () => {
    const authority = new TokenAuthority(Buffer.alloc(32, 3));
    const issued = authority.issue("cli");

    expect(issued.plaintext).toMatch(/^relay_cli_/);
    expect(authority.verify(issued.plaintext, issued.digest)).toBe(true);
    expect(authority.verify(`${issued.plaintext}x`, issued.digest)).toBe(false);
    expect(issued.digest).not.toContain(issued.plaintext);
  });

  test("domain-separates token digests", () => {
    const authority = new TokenAuthority(Buffer.alloc(32, 3));
    expect(authority.digest("same", "cli")).not.toBe(authority.digest("same", "device"));
  });
});

describe("SecretBox", () => {
  test("round-trips a token without exposing it in ciphertext", () => {
    const box = SecretBox.fromBase64(masterKey);
    const encrypted = box.seal("apns-device-token", "device:1");

    expect(encrypted).not.toContain("apns-device-token");
    expect(box.open(encrypted, "device:1")).toBe("apns-device-token");
  });

  test("rejects ciphertext in the wrong context or after tampering", () => {
    const box = SecretBox.fromBase64(masterKey);
    const encrypted = box.seal("secret", "device:1");
    const parts = encrypted.split(".");
    const ciphertext = parts[3] ?? "";
    parts[3] = `${ciphertext[0] === "A" ? "B" : "A"}${ciphertext.slice(1)}`;

    expect(() => box.open(encrypted, "device:2")).toThrow();
    expect(() => box.open(parts.join("."), "device:1")).toThrow();
  });
});
