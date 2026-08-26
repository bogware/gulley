import { resolveAdmin, signAdminSession } from '@gulley/auth';
import { randomBytes, randomUUID } from 'node:crypto';
import { sessionToken } from './admin';
import type { ControlContext } from './context';
import {
  buildAuthorizeUrl,
  clearCookie,
  exchangeCode,
  extractGroups,
  FLOW_COOKIE,
  mapMemberships,
  parseCookies,
  serializeCookie,
  SESSION_COOKIE,
  signFlow,
  verifyFlow,
} from './oidc-gate';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

function oidcError(reply: FastifyReply, code: number, message: string): FastifyReply {
  return reply.code(code).send({ error: { type: 'oidc', message } });
}

/**
 * Browser OIDC session gate: /auth/login → the IdP (auth-code + PKCE); /auth/callback
 * verifies the id_token and mints an admin-session cookie; /auth/me reports the
 * current identity; /auth/logout clears it. Enabled only when ctx.oidc is set.
 */
export function registerOidcRoutes(app: FastifyInstance, ctx: ControlContext): void {
  const now = (): number => ctx.resolverDeps.now ?? Date.now();

  app.get('/auth/config', async (_req, reply) =>
    reply.send({ enabled: Boolean(ctx.oidc), loginUrl: '/auth/login' }),
  );

  app.get('/auth/login', async (_req: FastifyRequest, reply: FastifyReply) => {
    const oidc = ctx.oidc;
    if (!oidc) return oidcError(reply, 404, 'OIDC is not configured');
    const secret = ctx.resolverDeps.sessionSecrets[0];
    if (!secret) return oidcError(reply, 500, 'no session secret configured');

    const state = randomBytes(16).toString('base64url');
    const nonce = randomBytes(16).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    let md;
    try {
      md = await oidc.provider.metadataDoc();
    } catch (e) {
      return oidcError(reply, 502, `OIDC discovery failed: ${(e as Error).message}`);
    }
    const url = buildAuthorizeUrl(md, {
      clientId: oidc.clientId,
      redirectUri: oidc.redirectUri,
      scopes: oidc.scopes,
      state,
      nonce,
      verifier,
    });
    const flow = signFlow(secret, {
      state,
      verifier,
      nonce,
      returnTo: oidc.postLoginRedirect,
      exp: now() + 600_000,
    });
    reply.header(
      'set-cookie',
      serializeCookie(FLOW_COOKIE, flow, { secure: oidc.cookieSecure, maxAge: 600 }),
    );
    return reply.redirect(url);
  });

  app.get('/auth/callback', async (request: FastifyRequest, reply: FastifyReply) => {
    const oidc = ctx.oidc;
    if (!oidc) return oidcError(reply, 404, 'OIDC is not configured');
    const secret = ctx.resolverDeps.sessionSecrets[0];
    if (!secret) return oidcError(reply, 500, 'no session secret configured');

    const q = request.query as { code?: string; state?: string; error?: string };
    if (q.error) return oidcError(reply, 400, `IdP error: ${q.error}`);
    const flow = verifyFlow(secret, parseCookies(request.headers.cookie)[FLOW_COOKIE] ?? '', now());
    if (!flow || flow.state !== q.state || !q.code) {
      return oidcError(reply, 400, 'invalid or expired login state');
    }

    let md;
    let tokens;
    try {
      md = await oidc.provider.metadataDoc();
      tokens = await exchangeCode(
        md,
        {
          clientId: oidc.clientId,
          clientSecret: oidc.clientSecret,
          redirectUri: oidc.redirectUri,
          code: q.code,
          verifier: flow.verifier,
        },
        oidc.fetchImpl,
      );
    } catch (e) {
      return oidcError(reply, 502, `token exchange failed: ${(e as Error).message}`);
    }
    if (!tokens.id_token) return oidcError(reply, 502, 'no id_token returned');

    const verified = await oidc.provider.verify(tokens.id_token, {
      audience: oidc.clientId,
      nonce: flow.nonce,
    });
    if (!verified.ok) return oidcError(reply, 401, `id_token rejected: ${verified.reason}`);

    const claims = verified.claims;
    const groups = extractGroups(claims as Record<string, unknown>, oidc.groupsClaim);
    const orgIds = ctx.orgs.list('*').map((o) => o.id);
    const memberships = mapMemberships(groups, oidc.roleRules, orgIds);

    const ttlSec = Math.floor(ctx.resolverDeps.maxSessionTtlMs / 1000);
    const iat = Math.floor(now() / 1000);
    const token = signAdminSession(secret, {
      sub: claims.sub ?? 'oidc-user',
      name: claims.name ?? claims.preferred_username ?? claims.email ?? claims.sub ?? 'user',
      jti: randomUUID(),
      memberships,
      iat,
      exp: iat + ttlSec,
      typ: 'admin-session',
      ver: 1,
    });

    await ctx.audit.append({
      orgId: null,
      actor: claims.sub ?? 'oidc-user',
      action: 'admin.session.oidc',
      target: claims.sub ?? '',
      payload: { memberships: memberships.length, groups: groups.length },
    });

    reply.header('set-cookie', [
      serializeCookie(SESSION_COOKIE, token, { secure: oidc.cookieSecure, maxAge: ttlSec }),
      clearCookie(FLOW_COOKIE, { secure: oidc.cookieSecure }),
    ]);
    return reply.redirect(flow.returnTo);
  });

  app.get('/auth/me', async (request: FastifyRequest, reply: FastifyReply) => {
    const res = await resolveAdmin(sessionToken(request), ctx.resolverDeps);
    if (!res.ok) {
      return reply
        .code(401)
        .send({ error: { type: 'authentication_error', message: 'not authenticated' } });
    }
    return reply.send({
      subject: res.value.subject,
      name: res.value.displayName,
      memberships: res.value.memberships,
    });
  });

  app.post('/auth/logout', async (_req: FastifyRequest, reply: FastifyReply) => {
    reply.header('set-cookie', clearCookie(SESSION_COOKIE, { secure: ctx.oidc?.cookieSecure }));
    return reply.code(204).send();
  });
}
