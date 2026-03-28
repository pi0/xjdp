// Client-side Web Crypto helpers — isomorphic (browser + Node.js)

const ALGO: EcKeyGenParams = { name: "ECDSA", namedCurve: "P-384" };
const SIGN_ALGO: EcdsaParams = { name: "ECDSA", hash: "SHA-384" };

/** Generate an ECDSA P-384 key pair. */
export async function generateKeyPair(opts?: { extractable?: boolean }): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(ALGO, opts?.extractable ?? false, ["sign", "verify"]);
}

/** Serialize a key (public or private) to a compact base64 string */
export async function serializeKey(key: CryptoKey): Promise<string> {
  const jwk = await crypto.subtle.exportKey("jwk", key);
  const { key_ops: _, ext: _e, ...clean } = jwk;
  return btoa(JSON.stringify(clean)).replaceAll("=", "");
}

/** Parse a serialized key string back into a CryptoKeyPair (private) or CryptoKey (public) */
export async function parseKey(encoded: string): Promise<CryptoKeyPair | CryptoKey> {
  const padded = encoded + "=".repeat((4 - (encoded.length % 4)) % 4);
  const jwk: JsonWebKey = JSON.parse(atob(padded));
  const { key_ops: _, ext: _e, ...clean } = jwk;
  if (clean.d) {
    // Private key — return full key pair
    const privateKey = await crypto.subtle.importKey("jwk", clean, ALGO, false, ["sign"]);
    const { d: _d, ...pubJwk } = clean;
    const publicKey = await crypto.subtle.importKey("jwk", pubJwk, ALGO, true, ["verify"]);
    return { privateKey, publicKey };
  }
  // Public key only
  return crypto.subtle.importKey("jwk", clean, ALGO, true, ["verify"]);
}

/** Export public key as JWK */
export async function exportPublicKey(key: CryptoKey): Promise<JsonWebKey> {
  return crypto.subtle.exportKey("jwk", key);
}

/** Import a public key from JWK */
export async function importPublicKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", jwk, ALGO, true, ["verify"]);
}

/** Export private key as JWK (only works if key was generated with extractable: true) */
export async function exportPrivateKey(key: CryptoKey): Promise<JsonWebKey> {
  return crypto.subtle.exportKey("jwk", key);
}

/** Import a private key from JWK (returns both private + derived public key) */
export async function importKeyPair(jwk: JsonWebKey): Promise<CryptoKeyPair> {
  const { key_ops: _, ext: _e, ...clean } = jwk;
  const privateKey = await crypto.subtle.importKey("jwk", clean, ALGO, false, ["sign"]);
  const { d: _d, ...pubJwk } = clean;
  const publicKey = await importPublicKey(pubJwk);
  return { privateKey, publicKey };
}

/** Sign data with private key */
export async function sign(privateKey: CryptoKey, data: ArrayBuffer): Promise<ArrayBuffer> {
  return crypto.subtle.sign(SIGN_ALGO, privateKey, data);
}

/** SHA-256 fingerprint of a public key (hex) */
export async function fingerprint(publicKey: CryptoKey): Promise<string> {
  const jwk = await exportPublicKey(publicKey);
  const encoded = new TextEncoder().encode(JSON.stringify(jwk));
  const hash = await crypto.subtle.digest("SHA-256", encoded);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function b64ToBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer as ArrayBuffer;
}

export function bufferToB64(buffer: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)));
}
