// Web Crypto utilities for ECDSA P-384

const ALGO: EcKeyGenParams = { name: "ECDSA", namedCurve: "P-384" };
const SIGN_ALGO: EcdsaParams = { name: "ECDSA", hash: "SHA-384" };

export async function generateKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(ALGO, false, ["sign", "verify"]);
}

export async function exportPublicKey(key: CryptoKey): Promise<JsonWebKey> {
  return crypto.subtle.exportKey("jwk", key);
}

export async function importPublicKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", jwk, ALGO, true, ["verify"]);
}

export async function sign(privateKey: CryptoKey, data: BufferSource): Promise<ArrayBuffer> {
  return crypto.subtle.sign(SIGN_ALGO, privateKey, data);
}

export async function verify(
  publicKey: CryptoKey,
  signature: BufferSource,
  data: BufferSource,
): Promise<boolean> {
  return crypto.subtle.verify(SIGN_ALGO, publicKey, signature, data);
}

/** SHA-256 fingerprint of a public JWK (hex string) */
export async function fingerprint(publicKey: CryptoKey): Promise<string> {
  const jwk = await exportPublicKey(publicKey);
  const encoded = new TextEncoder().encode(JSON.stringify(jwk));
  const hash = await crypto.subtle.digest("SHA-256", encoded);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Generate a 32-byte random nonce as base64 */
export function generateNonce(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

export function b64ToBuffer(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function bufferToB64(buffer: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)));
}
