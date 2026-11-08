import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export function encryptionKey(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(value)
    || Buffer.from(value, "base64").length !== 32) throw new Error("A 32-byte base64 token key is required.");
  return Buffer.from(value, "base64");
}
const binding = (r) => Buffer.from(`${r.jobId}\0${r.status}`, "utf8");
export function sealResponse(response, key) {
  if (typeof response?.intakeToken !== "string" || response.intakeToken.length < 8) {
    throw new Error("A private intake token is required.");
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(binding(response));
  const ciphertext = Buffer.concat([cipher.update(response.intakeToken, "utf8"), cipher.final()]);
  const { intakeToken: _token, ...rest } = response;
  return { ...rest, intakeTokenCiphertext: ["v1", iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".") };
}
export function openResponse(response, key) {
  const parts = String(response?.intakeTokenCiphertext || "").split(".");
  if (parts.length !== 4 || parts[0] !== "v1") throw new Error("Invalid private response.");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parts[1], "base64url"));
  decipher.setAAD(binding(response));
  decipher.setAuthTag(Buffer.from(parts[2], "base64url"));
  const intakeToken = Buffer.concat([decipher.update(Buffer.from(parts[3], "base64url")), decipher.final()]).toString("utf8");
  const { intakeTokenCiphertext: _ciphertext, ...rest } = response;
  return { ...rest, intakeToken };
}
