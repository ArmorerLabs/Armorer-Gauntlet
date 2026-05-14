import {
  type AppMessage,
  type DeviceIdentity,
  type DeviceRole,
  type EncryptedPayload,
  type JsonValue,
  type PrivateKeyJwk,
  type PublicKeyJwk,
  randomId
} from "./protocol.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function getCrypto(): Crypto {
  if (!globalThis.crypto?.subtle) {
    throw new Error("WebCrypto subtle API is required for Armorer Gauntlet crypto");
  }
  return globalThis.crypto;
}

export async function createDeviceIdentity(role: DeviceRole): Promise<DeviceIdentity> {
  const cryptoApi = getCrypto();
  const keyPair = await cryptoApi.subtle.generateKey(
    {
      name: "ECDH",
      namedCurve: "P-256"
    },
    true,
    ["deriveKey"]
  );
  const publicKey = (await cryptoApi.subtle.exportKey("jwk", keyPair.publicKey)) as PublicKeyJwk;
  const privateKey = (await cryptoApi.subtle.exportKey("jwk", keyPair.privateKey)) as PrivateKeyJwk;

  return {
    deviceId: randomId(role),
    role,
    publicKey,
    privateKey,
    createdAt: new Date().toISOString()
  };
}

export async function deriveSharedAesKey(
  privateKeyJwk: PrivateKeyJwk,
  peerPublicKeyJwk: PublicKeyJwk
): Promise<CryptoKey> {
  const cryptoApi = getCrypto();
  const privateKey = await cryptoApi.subtle.importKey(
    "jwk",
    privateKeyJwk,
    {
      name: "ECDH",
      namedCurve: "P-256"
    },
    false,
    ["deriveKey"]
  );
  const publicKey = await cryptoApi.subtle.importKey(
    "jwk",
    peerPublicKeyJwk,
    {
      name: "ECDH",
      namedCurve: "P-256"
    },
    false,
    []
  );

  return cryptoApi.subtle.deriveKey(
    {
      name: "ECDH",
      public: publicKey
    },
    privateKey,
    {
      name: "AES-GCM",
      length: 256
    },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function encryptAppMessage(
  key: CryptoKey,
  message: AppMessage
): Promise<EncryptedPayload> {
  const cryptoApi = getCrypto();
  const nonce = cryptoApi.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(message));
  const ciphertext = await cryptoApi.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(nonce)
    },
    key,
    toArrayBuffer(plaintext)
  );

  return {
    alg: "ECDH-P256+A256GCM",
    nonce: bytesToBase64Url(nonce),
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext))
  };
}

export async function decryptAppMessage(
  key: CryptoKey,
  payload: EncryptedPayload
): Promise<AppMessage> {
  if (payload.alg !== "ECDH-P256+A256GCM") {
    throw new Error(`Unsupported payload algorithm: ${payload.alg}`);
  }
  const cryptoApi = getCrypto();
  const plaintext = await cryptoApi.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(base64UrlToBytes(payload.nonce))
    },
    key,
    toArrayBuffer(base64UrlToBytes(payload.ciphertext))
  );
  return JSON.parse(decoder.decode(plaintext)) as AppMessage;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await getCrypto().subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.padEnd(value.length + ((4 - (value.length % 4)) % 4), "=");
  const base64 = padded.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function assertJsonValue(value: unknown): asserts value is JsonValue {
  if (!isJsonValue(value)) {
    throw new Error("Value is not JSON serializable");
  }
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  if (["string", "number", "boolean"].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).every(isJsonValue);
  }
  return false;
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
