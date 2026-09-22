// lib/crypto.ts
const ALGORITHM = 'AES-GCM';
const KEY_LENGTH = 256;
const IV_LENGTH = 12; 

export async function generateKey(): Promise<CryptoKey> {
  return window.crypto.subtle.generateKey(
    { name: ALGORITHM, length: KEY_LENGTH },
    true, 
    ['encrypt', 'decrypt']
  ) as Promise<CryptoKey>;
}

export async function exportKeyToBase64(key: CryptoKey): Promise<string> {
  const exported = await window.crypto.subtle.exportKey('raw', key);
  const bytes = new Uint8Array(exported);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export async function importKeyFromBase64(base64Key: string): Promise<CryptoKey> {
  const binary = atob(base64Key);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return window.crypto.subtle.importKey(
    'raw',
    bytes,
    { name: ALGORITHM, length: KEY_LENGTH },
    true,
    ['encrypt', 'decrypt']
  ) as Promise<CryptoKey>;
}

export async function encryptText(plainText: string, key: CryptoKey): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(plainText);
  const iv = window.crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  
  const encryptedBuffer = await window.crypto.subtle.encrypt(
    { name: ALGORITHM, iv: iv },
    key,
    data
  );

  const encryptedArray = new Uint8Array(encryptedBuffer);
  const combined = new Uint8Array(iv.length + encryptedArray.length);
  combined.set(iv, 0);
  combined.set(encryptedArray, iv.length);

  let binary = '';
  for (let i = 0; i < combined.byteLength; i++) {
    binary += String.fromCharCode(combined[i]);
  }
  return btoa(binary);
}

export async function decryptText(base64Payload: string, key: CryptoKey): Promise<string> {
  const binary = atob(base64Payload);
  const combined = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    combined[i] = binary.charCodeAt(i);
  }

  const iv = combined.slice(0, IV_LENGTH);
  const ciphertext = combined.slice(IV_LENGTH);

  const decryptedBuffer = await window.crypto.subtle.decrypt(
    { name: ALGORITHM, iv: iv },
    key,
    ciphertext
  );

  const decoder = new TextDecoder();
  return decoder.decode(decryptedBuffer);
}