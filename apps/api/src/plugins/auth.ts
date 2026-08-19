import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import jwt from '@fastify/jwt';
import cookie from '@fastify/cookie';
import { and, eq, isNull, gt } from 'drizzle-orm';
import { db, env, sha256, tables } from '@pulse/core';
import { forbidden, unauthorized } from '../lib/http.js';

export interface AuthUser {
  id: string;
  email: string;
  role: string;
  planId: string;
  /** True when the caller authenticated with an API key rather than a session. */
  viaApiKey?: boolean;
}

// @fastify/jwt owns `request.user`; teaching it our payload shape keeps a single
// typed accessor instead of a parallel decorator.
declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; email: string; role: string; plan: string };
    user: AuthUser;
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    requireAuth: (req: FastifyRequest) => Promise<AuthUser>;
  }
}

export const REFRESH_COOKIE = 'pulse_rt';

const plugin: FastifyPluginAsync = async (app) => {
  await app.register(cookie, { secret: env.JWT_SECRET });
  await app.register(jwt, {
    secret: env.JWT_SECRET,
    sign: { expiresIn: env.ACCESS_TOKEN_TTL },
  });

  app.decorate('requireAuth', async (req: FastifyRequest): Promise<AuthUser> => {
    if (req.user) return req.user;

    // API keys are an alternative to a session for machine-to-machine reads.
    const apiKey = req.headers['x-api-key'];
    if (typeof apiKey === 'string' && apiKey.length > 0) {
      const user = await resolveApiKey(apiKey);
      if (!user) throw unauthorized('Invalid API key');
      // Deliberately read-only. An integration key that leaks should not be able
      // to delete a fleet, and every mutating path already has a session behind it.
      if (req.method !== 'GET') {
        throw forbidden('API keys are read-only — use a signed-in session for this operation');
      }
      req.user = user;
      return user;
    }

    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw unauthorized();

    try {
      const payload = app.jwt.verify<{ sub: string; email: string; role: string; plan: string }>(
        header.slice(7),
      ) as { sub: string; email: string; role: string; plan: string };
      const user: AuthUser = {
        id: payload.sub,
        email: payload.email,
        role: payload.role,
        planId: payload.plan,
      };
      req.user = user;
      return user;
    } catch {
      throw unauthorized('Session expired');
    }
  });
};

export const authPlugin = fp(plugin, { name: 'pulse-auth' });

/**
 * `last_used_at` is useful for spotting a forgotten key, but writing it on every
 * request would turn a read endpoint into a write. One update per key per minute
 * carries the same information at a fraction of the cost.
 */
const LAST_USED_THROTTLE_MS = 60_000;
const lastUsedWrites = new Map<string, number>();

async function resolveApiKey(key: string): Promise<AuthUser | null> {
  const rows = await db
    .select({
      keyId: tables.apiKeys.id,
      id: tables.users.id,
      email: tables.users.email,
      role: tables.users.role,
      planId: tables.users.planId,
    })
    .from(tables.apiKeys)
    .innerJoin(tables.users, eq(tables.users.id, tables.apiKeys.userId))
    .where(eq(tables.apiKeys.keyHash, sha256(key)))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const now = Date.now();
  const wroteAt = lastUsedWrites.get(row.keyId) ?? 0;
  if (now - wroteAt > LAST_USED_THROTTLE_MS) {
    lastUsedWrites.set(row.keyId, now);
    // Fire and forget: a failed bookkeeping write must not fail the request.
    void db
      .update(tables.apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(tables.apiKeys.id, row.keyId))
      .catch(() => undefined);
  }

  return { id: row.id, email: row.email, role: row.role, planId: row.planId, viaApiKey: true };
}

export function signAccessToken(
  app: FastifyInstance,
  user: { id: string; email: string; role: string; planId: string },
): string {
  return app.jwt.sign({ sub: user.id, email: user.email, role: user.role, plan: user.planId });
}

export async function persistRefreshToken(userId: string, token: string, userAgent?: string) {
  const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
  await db.insert(tables.refreshTokens).values({
    userId,
    tokenHash: sha256(token),
    expiresAt,
    userAgent: userAgent?.slice(0, 200),
  });
  return expiresAt;
}

/** Single-use refresh tokens: consuming one immediately revokes it. */
export async function consumeRefreshToken(token: string): Promise<string | null> {
  const hash = sha256(token);
  const rows = await db
    .update(tables.refreshTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(tables.refreshTokens.tokenHash, hash),
        isNull(tables.refreshTokens.revokedAt),
        gt(tables.refreshTokens.expiresAt, new Date()),
      ),
    )
    .returning({ userId: tables.refreshTokens.userId });

  return rows[0]?.userId ?? null;
}

export async function revokeAllRefreshTokens(userId: string): Promise<void> {
  await db
    .update(tables.refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(tables.refreshTokens.userId, userId), isNull(tables.refreshTokens.revokedAt)));
}

export function refreshCookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: env.COOKIE_SECURE,
    path: '/api/v1/auth',
    maxAge: maxAgeSeconds,
  };
}
