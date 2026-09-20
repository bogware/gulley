import { resolveAdmin, signAdminSession, verifyAdminSession } from '@gulley/auth';
import { randomBytes, randomUUID } from 'node:crypto';
import { sessionToken } from './admin';
import type { ControlContext } from './context';
import {
  buildAuthorizeUrl,
  clearCookie,
  exchangeCode,
  extractGroups,
  FLOW_COOKIE,
  hasGroupOverage,
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
      _req.log.error({ err: e }, 'OIDC discovery failed');
      return oidcError(reply, 502, 'identity provider discovery failed');
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
        { timeoutMs: oidc.exchangeTimeoutMs, assertAllowed: oidc.assertEgress },
      );
    } catch (e) {
      // The detail (IdP host, status, driver text) goes to the log, not the browser.
      request.log.error({ err: e }, 'OIDC token exchange failed');
      return oidcError(reply, 502, 'identity provider token exchange failed');
    }
    if (!tokens.id_token) return oidcError(reply, 502, 'no id_token returned');

    const verified = await oidc.provider.verify(tokens.id_token, {
      audience: oidc.clientId,
      nonce: flow.nonce,
    });
    if (!verified.ok) return oidcError(reply, 401, `id_token rejected: ${verified.reason}`);

    const claims = verified.claims;
    const groups = extractGroups(claims as Record<string, unknown>, oidc.groupsClaim);
    const overage = hasGroupOverage(claims as Record<string, unknown>);
    const orgIds = ctx.orgs.list('*').map((o) => o.id);
    const memberships = mapMemberships(groups, oidc.roleRules, orgIds);
    if (overage && memberships.length === 0) {
      request.log.warn(
        'OIDC login: Entra returned a groups-overage indirection and no App Role matched — ' +
          'this principal is in >200 groups. Map roles via Entra App Roles (the `roles` claim) ' +
          'to avoid the overage. This user has no memberships from the token.',
      );
    }

    const ttlSec = Math.floor(ctx.resolverDeps.maxSessionTtlMs / 1000);
    const iat = Math.floor(now() / 1000);
    const jti = randomUUID();
    // The admin subject is the configured claim (default `sub`); an IdP whose SCIM
    // userName is the UPN/email sets OIDC_SUBJECT_CLAIM so SSO + SCIM + RBAC grants +
    // session revocation all key on ONE identity. Fail closed on a missing claim.
    const subjectClaim = oidc.subjectClaim ?? 'sub';
    const rawSubject = (claims as Record<string, unknown>)[subjectClaim];
    const subject =
      typeof rawSubject === 'string' && rawSubject.length > 0 ? rawSubject : undefined;
    if (!subject) {
      request.log.warn({ claim: subjectClaim }, 'OIDC login: subject claim missing from id_token');
      return oidcError(reply, 401, 'id_token has no usable subject claim');
    }
    const token = signAdminSession(secret, {
      sub: subject,
      name: claims.name ?? claims.preferred_username ?? claims.email ?? subject,
      jti,
      memberships,
      iat,
      exp: iat + ttlSec,
      typ: 'admin-session',
      ver: 1,
      src: 'oidc',
    });
    await ctx.sessions.record?.({
      jti,
      subject,
      source: 'oidc',
      createdAt: new Date(iat * 1000).toISOString(),
      expiresAt: new Date((iat + ttlSec) * 1000).toISOString(),
    });

    // Persist the SSO principal into the durable admin-user directory so it is one
    // identity across SSO, RBAC, SCIM, and the console — and so a SCIM/admin grant
    // (unioned in by membershipLoader) applies, and a SCIM/Graph deprovision can
    // deactivate it. Best-effort: a directory hiccup must not block login.
    if (ctx.adminUsers) {
      try {
        await ctx.adminUsers.upsertBySubject(
          subject,
          claims.name ?? claims.preferred_username ?? claims.email ?? subject,
          claims.email ?? null,
        );
      } catch (e) {
        request.log.warn({ err: (e as Error).message }, 'OIDC login: admin-user upsert failed');
      }
    }

    await ctx.audit.append({
      orgId: null,
      actor: subject,
      action: 'admin.session.oidc',
      target: subject,
      payload: { jti, memberships: memberships.length, groups: groups.length, overage },
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

  // Logout REVOKES the session (by jti) as well as clearing the cookie: a copied cookie
  // or bearer used to stay valid until exp after "sign out". Best-effort — an
  // unverifiable/absent token still clears the cookie (idempotent 204).
  app.post('/auth/logout', async (request: FastifyRequest, reply: FastifyReply) => {
    const token = sessionToken(request);
    if (token) {
      const v = verifyAdminSession(ctx.resolverDeps.sessionSecrets, token, {
        now: now(),
        maxTtlMs: ctx.resolverDeps.maxSessionTtlMs,
      });
      if (v.ok) {
        await ctx.sessions.revoke(v.value.jti);
        await ctx.audit.append({
          orgId: null,
          actor: v.value.principal.subject,
          action: 'admin.session.logout',
          target: v.value.jti,
          payload: { jti: v.value.jti, source: v.value.source },
        });
      }
    }
    reply.header('set-cookie', clearCookie(SESSION_COOKIE, { secure: ctx.oidc?.cookieSecure }));
    return reply.code(204).send();
  });
}
