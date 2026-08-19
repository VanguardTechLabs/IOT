import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';

const ARGON_OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export async function hashPassword(plain: string): Promise<string> {
  return argonHash(plain, ARGON_OPTIONS);
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argonVerify(hash, plain, ARGON_OPTIONS);
  } catch {
    return false;
  }
}

/**
 * Device / service-account secrets use salted SHA-256 rather than argon2, because
 * EMQX validates them on every broker connection and the HTTP ingest path validates
 * them on every request. The secret is 32 bytes of CSPRNG output, so it has no
 * dictionary surface for a fast hash to expose.
 *
 * Must stay byte-compatible with EMQX's `sha256` + `salt_position = suffix`.
 */
export function sha256Salted(secret: string, salt: string): string {
  return createHash('sha256').update(secret + salt).digest('hex');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function newSalt(bytes = 8): string {
  return randomBytes(bytes).toString('hex');
}

export function newSecret(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}

export function newDeviceKey(): string {
  return `dev_${randomBytes(9).toString('hex')}`;
}

export function newDeviceToken(): string {
  return `tok_${randomBytes(24).toString('base64url')}`;
}

export function newApiKey(): string {
  return `pk_${randomBytes(24).toString('base64url')}`;
}

export function preview(secret: string): string {
  return `${secret.slice(0, 8)}…${secret.slice(-4)}`;
}

export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}
