import { generateServiceProviderMetadata } from '@node-saml/node-saml';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ControlContext } from './context';
import { clearCookie, parseCookies, serializeCookie } from './cookies';
import { signFlow, verifyFlow } from './oidc-gate';
import {
  assertionMeta,
  buildSaml,
  newSamlRequestId,
  ReplayGuard,
  responseDestination,
  SAML_FLOW_COOKIE,
  SAML_FLOW_TTL_MS,
  type SamlFlow,
  samlDisplayName,
  samlEmail,
  samlGroups,
  samlSubject,
} from './saml-gate';
import { completeSsoLogin, mapMemberships, safeReturnTo } from './sso';

/** The ACS path — exempt from the Sec-Fetch-Site CSRF hook (http-edge.ts) because the
 *  IdP POSTs it cross-site by design. Its CSRF defence is the signed flow cookie +
 *  RelayState + InResponseTo binding below, plus the assertion signature. */
export const SAML_ACS_PATH = '/auth/saml/acs';

const MAX_SAML_RESPONSE_BYTES = 256 * 1024;

function samlError(reply: FastifyReply, code: number, message: string): FastifyReply {
  return reply.code(code).send({ error: { type: 'saml', message } });
}

/**
 * Browser SAML 2.0 session gate (SP-initiated, HTTP-Redirect out / HTTP-POST back):
 *   GET  /auth/saml/login     → AuthnRequest redirect to the IdP; the flow (RelayState
 *                               `state`, AuthnRequest id, issue time, return path) is
 *                               HMAC-signed into a browser-bound flow cookie.
 *   POST /auth/saml/acs       → validates the Response (signature against the IdP cert,
 *                               issuer, audience = SP entity id, Destination = ACS URL,
 *                               NotBefore/NotOnOrAfter, InResponseTo = the flow's
 *                               request id, assertion-id replay guard), maps attributes
 *                               → groups → memberships with the shared SSO role map,
 *                               and mints the admin session (source `saml`).
 *   GET  /auth/saml/metadata  → SP metadata XML for the IdP side.
 * IdP-initiated responses (no InResponseTo, no flow) are refused unless
 * SAML_ALLOW_IDP_INITIATED is on. Mounted only when ctx.saml is set.
 */
export function registerSamlRoutes(app: FastifyInstance, ctx: ControlContext): void {
  const cfg = ctx.saml;
  if (!cfg) return;
  const now = (): number => ctx.resolverDeps.now ?? Date.now();
  const replay = new ReplayGuard();
  // Cross-site POST from the IdP: the flow cookie must ride it, which needs
  // SameSite=None (and therefore Secure). On a non-TLS dev edge `None` is refused by
  // browsers, so the attribute is omitted (Chrome's Lax-by-default still sends a
  // fresh attribute-less cookie on a top-level cross-site POST; Firefox/Safari send it).
  const flowCookieOpts = {
    secure: cfg.cookieSecure,
    maxAge: Math.floor(SAML_FLOW_TTL_MS / 1000),
    sameSite: cfg.cookieSecure ? ('None' as const) : null,
  };

  app.get('/auth/saml/login', async (request: FastifyRequest, reply: FastifyReply) => {
    const secret = ctx.resolverDeps.sessionSecrets[0];
    if (!secret) return samlError(reply, 500, 'no session secret configured');
    const returnTo = safeReturnTo(
      (request.query as Record<string, unknown> | undefined)?.['return_to'],
      cfg.postLoginRedirect,
    );
    const flow: SamlFlow = {
      state: randomBytes(16).toString('base64url'),
      requestId: newSamlRequestId(),
      issuedAt: new Date(now()).toISOString(),
      returnTo,
      exp: now() + SAML_FLOW_TTL_MS,
    };
    let url: string;
    try {
      // RelayState is the short random `state` (the SAML binding caps RelayState at 80
      // bytes); the signed flow travels in the cookie.
      url = await buildSaml(cfg, { requestId: flow.requestId }).getAuthorizeUrlAsync(
        flow.state,
        undefined,
        {},
      );
    } catch (e) {
      request.log.error({ err: e }, 'SAML AuthnRequest generation failed');
      return samlError(reply, 500, 'could not build the SAML request');
    }
    reply.header(
      'set-cookie',
      serializeCookie(SAML_FLOW_COOKIE, signFlow(secret, flow), flowCookieOpts),
    );
    return reply.redirect(url);
  });

  app.post(SAML_ACS_PATH, async (request: FastifyRequest, reply: FastifyReply) => {
    const secret = ctx.resolverDeps.sessionSecrets[0];
    if (!secret) return samlError(reply, 500, 'no session secret configured');
    const b = (request.body ?? {}) as Record<string, unknown>;
    const samlResponse = b['SAMLResponse'];
    if (typeof samlResponse !== 'string' || samlResponse.length === 0)
      return samlError(reply, 400, 'SAMLResponse missing');
    if (samlResponse.length > MAX_SAML_RESPONSE_BYTES)
      return samlError(reply, 400, 'SAMLResponse too large');
    const relayState = typeof b['RelayState'] === 'string' ? b['RelayState'] : '';

    // The browser-bound flow: a response must answer THIS browser's AuthnRequest.
    const flowCookie = parseCookies(request.headers.cookie)[SAML_FLOW_COOKIE];
    const flow = flowCookie ? verifyFlow<SamlFlow>(secret, flowCookie, now()) : null;
    if (flow && (typeof flow.state !== 'string' || typeof flow.requestId !== 'string'))
      return samlError(reply, 400, 'invalid or expired login state');
    if (flow && relayState !== flow.state)
      return samlError(reply, 400, 'invalid or expired login state');
    const idpInitiated = !flow;
    if (idpInitiated && !cfg.allowIdpInitiated)
      return samlError(reply, 400, 'invalid or expired login state');

    const saml = buildSaml(
      cfg,
      flow
        ? { expected: { requestId: flow.requestId, issuedAt: flow.issuedAt } }
        : { idpInitiated: true },
    );
    let profile;
    try {
      const r = await saml.validatePostResponseAsync({
        SAMLResponse: samlResponse,
        ...(relayState ? { RelayState: relayState } : {}),
      });
      profile = r.profile;
    } catch (e) {
      // The library's messages are protocol-level ("Invalid signature", "SAML assertion
      // audience mismatch", …) — safe to echo; detail goes to the log.
      const message = e instanceof Error ? e.message : String(e);
      request.log.warn({ err: e, idpInitiated }, 'SAML response rejected');
      return samlError(reply, 401, `assertion rejected: ${message}`);
    }
    if (!profile) return samlError(reply, 401, 'assertion rejected: no assertion');

    // Destination must name this ACS (node-saml does not check it).
    const xml = profile.getSamlResponseXml?.() ?? Buffer.from(samlResponse, 'base64').toString();
    const destination = responseDestination(xml);
    if (destination !== undefined && destination !== cfg.callbackUrl) {
      request.log.warn({ destination }, 'SAML response Destination mismatch');
      return samlError(reply, 401, 'assertion rejected: destination mismatch');
    }
    if (profile.issuer !== cfg.idpIssuer) {
      request.log.warn({ issuer: profile.issuer }, 'SAML assertion issuer mismatch');
      return samlError(reply, 401, 'assertion rejected: issuer mismatch');
    }
    // Replay: a bearer assertion is single-use for its validity window.
    const meta = assertionMeta(profile);
    if (!meta.id) return samlError(reply, 401, 'assertion rejected: missing assertion id');
    const expiresAt = Math.min(
      meta.notOnOrAfterMs ?? now() + SAML_FLOW_TTL_MS,
      now() + 8 * 3_600_000,
    );
    if (replay.seen(meta.id, expiresAt + cfg.acceptedClockSkewMs, now())) {
      request.log.warn({ assertionId: meta.id }, 'SAML assertion replayed');
      return samlError(reply, 401, 'assertion rejected: replayed');
    }

    const subject = samlSubject(profile, cfg.subjectAttribute);
    if (!subject) {
      request.log.warn(
        { attribute: cfg.subjectAttribute },
        'SAML login: subject attribute missing',
      );
      return samlError(reply, 401, 'assertion has no usable subject');
    }
    const groups = samlGroups(profile, cfg.groupsAttribute);
    const orgIds = ctx.orgs.list('*').map((o) => o.id);
    const memberships = mapMemberships(groups, cfg.roleRules, orgIds);
    return completeSsoLogin(ctx, reply, {
      subject,
      name: samlDisplayName(profile) ?? samlEmail(profile) ?? subject,
      email: samlEmail(profile) ?? null,
      memberships,
      source: 'saml',
      cookieSecure: cfg.cookieSecure,
      // IdP-initiated: some IdPs pass a configured RelayState as the landing path.
      returnTo: flow ? flow.returnTo : relayState,
      fallbackRedirect: cfg.postLoginRedirect,
      auditAction: 'admin.session.saml',
      auditPayload: {
        groups: groups.length,
        idpInitiated,
        nameIdFormat: profile.nameIDFormat ?? null,
        assertionId: meta.id,
      },
      clearCookies: [SAML_FLOW_COOKIE],
      log: request.log,
    });
  });

  // SP metadata for the IdP side (entityID, ACS, NameID format, signing cert when
  // AuthnRequests are signed). Public, like an OIDC discovery document.
  app.get('/auth/saml/metadata', async (_request: FastifyRequest, reply: FastifyReply) => {
    const xml = generateServiceProviderMetadata({
      issuer: cfg.spEntityId,
      callbackUrl: cfg.callbackUrl,
      wantAssertionsSigned: cfg.wantAssertionsSigned,
      signatureAlgorithm: 'sha256',
      digestAlgorithm: 'sha256',
      ...(cfg.spPrivateKey && cfg.spCert
        ? { privateKey: cfg.spPrivateKey, publicCerts: cfg.spCert }
        : {}),
    });
    return reply.header('content-type', 'application/samlmetadata+xml; charset=utf-8').send(xml);
  });

  // Clearing the flow cookie after a failed attempt is the browser's job on expiry;
  // expose a clear for the console's "try again" (idempotent 204).
  app.post('/auth/saml/cancel', async (_request: FastifyRequest, reply: FastifyReply) => {
    reply.header('set-cookie', clearCookie(SAML_FLOW_COOKIE, { secure: cfg.cookieSecure }));
    return reply.code(204).send();
  });
}
