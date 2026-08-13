import type { BrokerService } from '@gulley/oauth';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { adminRoute, body, str } from './admin';
import type { ControlContext } from './context';

function oerr(reply: FastifyReply, status: number, error: string): FastifyReply {
  return reply.code(status).send({ error });
}

/** OAuth broker HTTP surface. Device authorization + PKCE auth-code, token
 *  (device_code / authorization_code / refresh_token), and revocation. The
 *  consent + authorize endpoints require an authenticated admin identity — the
 *  consenting user — so no client-supplied identity is trusted. */
export function registerOAuthRoutes(
  app: FastifyInstance,
  broker: BrokerService,
  ctx: ControlContext,
): void {
  app.post('/oauth/device_authorization', async (request, reply) => {
    const clientId = str(body(request)['client_id']);
    if (!clientId) return oerr(reply, 400, 'invalid_request');
    const r = await broker.deviceAuthorization(clientId);
    return r.ok ? reply.send(r.value) : reply.code(400).send(r.error);
  });

  app.post(
    '/oauth/device/authorize',
    adminRoute(ctx, async (request, reply, admin) => {
      const userCode = str(body(request)['user_code']);
      if (!userCode) return oerr(reply, 400, 'invalid_request');
      const r = await broker.deviceApprove(userCode, {
        subject: admin.subject,
        displayName: admin.displayName,
      });
      return r.ok ? reply.send({ approved: true }) : reply.code(400).send(r.error);
    }),
  );

  app.post('/oauth/token', async (request, reply) => {
    const b = body(request);
    const grantType = str(b['grant_type']);
    const clientId = str(b['client_id']) ?? '';
    if (grantType === 'device_code') {
      const dc = str(b['device_code']);
      if (!dc) return oerr(reply, 400, 'invalid_request');
      const r = await broker.tokenDeviceCode(dc, clientId);
      return r.ok ? reply.send(r.value) : reply.code(400).send(r.error);
    }
    if (grantType === 'refresh_token') {
      const rt = str(b['refresh_token']);
      if (!rt) return oerr(reply, 400, 'invalid_request');
      const r = await broker.refresh(rt, clientId);
      return r.ok ? reply.send(r.value) : reply.code(400).send(r.error);
    }
    if (grantType === 'authorization_code') {
      const code = str(b['code']);
      const verifier = str(b['code_verifier']);
      const redirectUri = str(b['redirect_uri']);
      if (!code || !verifier || !redirectUri) return oerr(reply, 400, 'invalid_request');
      const r = await broker.tokenAuthCode({ code, codeVerifier: verifier, redirectUri, clientId });
      return r.ok ? reply.send(r.value) : reply.code(400).send(r.error);
    }
    return oerr(reply, 400, 'unsupported_grant_type');
  });

  app.post('/oauth/revoke', async (request, reply) => {
    const token = str(body(request)['token']);
    if (token) await broker.revoke(token);
    return reply.send({}); // always 200, regardless of token validity
  });

  app.get(
    '/oauth/authorize',
    adminRoute(ctx, async (request, reply, admin) => {
      const q = (request.query ?? {}) as Record<string, unknown>;
      const clientId = str(q['client_id']);
      const redirectUri = str(q['redirect_uri']);
      const codeChallenge = str(q['code_challenge']);
      const method = str(q['code_challenge_method']) ?? '';
      const state = str(q['state']) ?? '';
      if (!clientId || !redirectUri || !codeChallenge) return oerr(reply, 400, 'invalid_request');
      const r = await broker.authorize({
        clientId,
        redirectUri,
        state,
        codeChallenge,
        codeChallengeMethod: method,
        identity: { subject: admin.subject, displayName: admin.displayName },
      });
      return r.ok ? reply.send(r.value) : reply.code(400).send(r.error);
    }),
  );
}
