import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import { db, env, getUserPlan, hashPassword, newSecret, tables, verifyPassword } from '@pulse/core';
import { HttpError, conflict, parse, unauthorized } from '../lib/http.js';
import {
  REFRESH_COOKIE,
  consumeRefreshToken,
  persistRefreshToken,
  refreshCookieOptions,
  revokeAllRefreshTokens,
  signAccessToken,
} from '../plugins/auth.js';

const credentialsSchema = z.object({
  email: z.string().trim().email().max(160),
  password: z.string().min(8, 'password must be at least 8 characters').max(128),
});

const registerSchema = credentialsSchema.extend({
  name: z.string().trim().min(1).max(80),
});

/** /refresh and /logout accept the token in the body for clients without cookies. */
const refreshSchema = z.object({ refreshToken: z.string().min(1).max(200).optional() });

/**
 * Native clients ask for the refresh token in the response body.
 *
 * A browser must never get it that way — httpOnly is the whole reason script
 * cannot steal a session there. But React Native has no cookie jar that survives
 * an app restart, so the token goes to the OS keychain instead, which is the
 * equivalent protection on that platform. Opt-in by header, so the web's
 * behaviour is byte-identical and no browser receives one by accident.
 */
function wantsBodyToken(req: { headers: Record<string, unknown> }): boolean {
  return String(req.headers['x-pulse-client'] ?? '').toLowerCase() === 'native';
}

export const authRoutes: FastifyPluginAsync = async (app) => {
  const refreshMaxAge = env.REFRESH_TOKEN_TTL_DAYS * 86_400;

  const issueSession = async (
    reply: FastifyReply,
    user: { id: string; email: string; name: string; role: string; planId: string },
    userAgent?: string,
    bodyToken = false,
  ) => {
    const refreshToken = newSecret(32);
    await persistRefreshToken(user.id, refreshToken, userAgent);
    // One or the other, never both: a token that exists in two places has two
    // chances to leak and only one of them can be revoked by clearing a cookie.
    if (!bodyToken) {
      reply.setCookie(REFRESH_COOKIE, refreshToken, refreshCookieOptions(refreshMaxAge));
    }
    const plan = await getUserPlan(user.id);
    return {
      accessToken: signAccessToken(app, user),
      ...(bodyToken ? { refreshToken } : {}),
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      plan,
    };
  };

  app.post('/register', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const body = parse(registerSchema, req.body);
    const email = body.email.toLowerCase();

    const existing = await db
      .select({ id: tables.users.id })
      .from(tables.users)
      .where(sql`lower(${tables.users.email}) = ${email}`)
      .limit(1);
    if (existing.length > 0) throw conflict('That email is already registered');

    // Bootstrap: the first account on a fresh deployment owns the admin panel, so
    // there is never a chicken-and-egg problem granting the first role.
    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(tables.users);
    const role = count === 0 ? 'admin' : 'user';

    const [created] = await db
      .insert(tables.users)
      .values({ email, name: body.name, passwordHash: await hashPassword(body.password), role })
      .returning({
        id: tables.users.id,
        email: tables.users.email,
        name: tables.users.name,
        role: tables.users.role,
        planId: tables.users.planId,
      });

    reply.code(201);
    return issueSession(reply, created!, req.headers['user-agent'], wantsBodyToken(req));
  });

  app.post('/login', { config: { rateLimit: { max: 15, timeWindow: '5 minutes' } } }, async (req, reply) => {
    const body = parse(credentialsSchema, req.body);
    const email = body.email.toLowerCase();

    const rows = await db
      .select({
        id: tables.users.id,
        email: tables.users.email,
        name: tables.users.name,
        role: tables.users.role,
        planId: tables.users.planId,
        passwordHash: tables.users.passwordHash,
      })
      .from(tables.users)
      .where(sql`lower(${tables.users.email}) = ${email}`)
      .limit(1);

    const user = rows[0];
    // Always run a verification so a missing account and a wrong password take
    // the same amount of time.
    const ok = await verifyPassword(
      user?.passwordHash ?? '$argon2id$v=19$m=19456,t=2,p=1$aaaaaaaaaaaaaaaa$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      body.password,
    );
    if (!user || !ok) throw unauthorized('Invalid email or password');

    return issueSession(reply, user, req.headers['user-agent'], wantsBodyToken(req));
  });

  app.post('/refresh', async (req, reply) => {
    const fromBody = parse(refreshSchema, req.body ?? {}).refreshToken;
    const token = req.cookies[REFRESH_COOKIE] ?? fromBody;
    if (!token) throw unauthorized('No session');

    const userId = await consumeRefreshToken(token);
    if (!userId) {
      reply.clearCookie(REFRESH_COOKIE, refreshCookieOptions(0));
      throw unauthorized('Session expired');
    }

    const rows = await db
      .select({
        id: tables.users.id,
        email: tables.users.email,
        name: tables.users.name,
        role: tables.users.role,
        planId: tables.users.planId,
      })
      .from(tables.users)
      .where(eq(tables.users.id, userId))
      .limit(1);

    const user = rows[0];
    if (!user) throw unauthorized('Account no longer exists');
    // Rotation: consumeRefreshToken already burned the old one, so a native
    // client needs the replacement handed back the same way it sent the original.
    return issueSession(reply, user, req.headers['user-agent'], Boolean(fromBody) || wantsBodyToken(req));
  });

  app.post('/logout', async (req, reply) => {
    const token = req.cookies[REFRESH_COOKIE] ?? parse(refreshSchema, req.body ?? {}).refreshToken;
    if (token) await consumeRefreshToken(token);
    reply.clearCookie(REFRESH_COOKIE, refreshCookieOptions(0));
    return { ok: true };
  });

  app.get('/me', async (req) => {
    const auth = await app.requireAuth(req);
    const rows = await db
      .select({
        id: tables.users.id,
        email: tables.users.email,
        name: tables.users.name,
        role: tables.users.role,
        createdAt: tables.users.createdAt,
      })
      .from(tables.users)
      .where(eq(tables.users.id, auth.id))
      .limit(1);

    const user = rows[0];
    if (!user) throw unauthorized();
    return { user, plan: await getUserPlan(user.id) };
  });

  app.post('/password', async (req) => {
    const auth = await app.requireAuth(req);
    const body = parse(
      z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(8).max(128) }),
      req.body,
    );

    const rows = await db
      .select({ passwordHash: tables.users.passwordHash })
      .from(tables.users)
      .where(eq(tables.users.id, auth.id))
      .limit(1);

    if (!rows[0] || !(await verifyPassword(rows[0].passwordHash, body.currentPassword))) {
      throw new HttpError(400, 'Current password is incorrect', 'bad_password');
    }

    await db
      .update(tables.users)
      .set({ passwordHash: await hashPassword(body.newPassword), updatedAt: new Date() })
      .where(eq(tables.users.id, auth.id));

    await revokeAllRefreshTokens(auth.id);
    return { ok: true };
  });
};
