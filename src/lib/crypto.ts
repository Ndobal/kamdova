/**
 * Password and token hashing on the Workers runtime.
 *
 * bcrypt/argon2 are native modules and are not available here, so passwords use
 * PBKDF2-HMAC-SHA256 via WebCrypto -- salted, iterated, and stored with the
 * parameters inline so the cost can be raised later without invalidating
 * existing hashes.
 *
 * Stored format:  pbkdf2$sha256$<iterations>$<salt_b64url>$<derived_b64url>
 *
 * NOTE ON COST: PBKDF2 at 100k iterations costs roughly 50-100ms of CPU. That
 * exceeds the Workers *free* tier 10ms CPU budget, so login needs Workers Paid
 * (30s CPU). Lower PASSWORD_HASH_ITERATIONS only with that trade-off in mind.
 */

const KEY_LENGTH_BITS = 256;
const SALT_BYTES = 16;

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    key,
    KEY_LENGTH_BITS,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string, iterations: number): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const derived = await derive(password, salt, iterations);
  return `pbkdf2$sha256$${iterations}$${toBase64Url(salt)}$${toBase64Url(derived)}`;
}

/**
 * Always runs the full derivation before comparing, and compares in constant
 * time, so a wrong password costs the same as a right one.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 5 || parts[0] !== 'pbkdf2' || parts[1] !== 'sha256') return false;

  const iterations = Number(parts[2]);
  if (!Number.isInteger(iterations) || iterations < 1) return false;

  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = fromBase64Url(parts[3]!);
    expected = fromBase64Url(parts[4]!);
  } catch {
    return false;
  }

  const actual = await derive(password, salt, iterations);
  return timingSafeEqual(actual, expected);
}

/** Returns true only if both length and every byte match, without early exit. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** Opaque, high-entropy secret handed to the user (verification links, resets). */
export function generateSecretToken(bytes = 32): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/**
 * Tokens are stored hashed, never in plaintext. They already carry full
 * entropy, so a single SHA-256 is sufficient here -- unlike a password, there
 * is no low-entropy guess space for an attacker to search.
 */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return toBase64Url(new Uint8Array(digest));
}

export const newId = (): string => crypto.randomUUID();
