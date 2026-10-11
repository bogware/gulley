import { signXml } from '@node-saml/node-saml/lib/xml';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config';
import { createInMemoryControlContext, type SamlSessionConfig } from './context';
import { ReplayGuard, responseDestination } from './saml-gate';
import { parseRoleMap } from './sso';
import { buildServer } from './server';

// --- a fake IdP: an RSA key whose PUBLIC KEY PEM is the configured "certificate" ---
// (node-saml accepts a PUBLIC KEY PEM for idpCert; node:crypto cannot mint X.509.)
const idp = generateKeyPairSync('rsa', { modulusLength: 2048 });
const idpPrivateKey = idp.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const idpPublicKey = idp.publicKey.export({ type: 'spki', format: 'pem' }) as string;
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherPrivateKey = other.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

const IDP_ISSUER = 'https://idp.test/saml';
const SP_ENTITY = 'urn:gulley:console-test';
const ACS = 'http://localhost:8081/auth/saml/acs';
const SESSION_SECRET = 'saml-check-session-secret-32-chars-min!!';

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

interface ResponseOpts {
  inResponseTo?: string | undefined;
  audience?: string;
  destination?: string;
  issuer?: string;
  notOnOrAfter?: Date;
  notBefore?: Date;
  groups?: string[];
  nameId?: string;
  sign?: 'assertion' | 'none' | 'wrong-key';
  assertionId?: string;
}

/** Build (and sign) a SAML Response the way an IdP would. */
function samlResponse(o: ResponseOpts = {}): string {
  const now = new Date();
  const notBefore = (o.notBefore ?? new Date(now.getTime() - 60_000)).toISOString();
  const notOnOrAfter = (o.notOnOrAfter ?? new Date(now.getTime() + 5 * 60_000)).toISOString();
  const issuer = o.issuer ?? IDP_ISSUER;
  const audience = o.audience ?? SP_ENTITY;
  const destination = o.destination ?? ACS;
  const assertionId = o.assertionId ?? `_a${randomBytes(8).toString('hex')}`;
  const responseId = `_r${randomBytes(8).toString('hex')}`;
  const irt = o.inResponseTo ? ` InResponseTo="${xmlEscape(o.inResponseTo)}"` : '';
  const groups = (o.groups ?? ['gulley-admins', 'eng'])
    .map((g) => `<saml:AttributeValue>${xmlEscape(g)}</saml:AttributeValue>`)
    .join('');
  const xml =
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${responseId}" Version="2.0" IssueInstant="${now.toISOString()}" Destination="${xmlEscape(destination)}"${irt}>` +
    `<saml:Issuer>${xmlEscape(issuer)}</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
    `<saml:Assertion ID="${assertionId}" Version="2.0" IssueInstant="${now.toISOString()}">` +
    `<saml:Issuer>${xmlEscape(issuer)}</saml:Issuer>` +
    `<saml:Subject>` +
    `<saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${xmlEscape(o.nameId ?? 'ada@acme.test')}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">` +
    `<saml:SubjectConfirmationData NotOnOrAfter="${notOnOrAfter}" Recipient="${xmlEscape(destination)}"${irt}/>` +
    `</saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}">` +
    `<saml:AudienceRestriction><saml:Audience>${xmlEscape(audience)}</saml:Audience></saml:AudienceRestriction>` +
    `</saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${now.toISOString()}" SessionIndex="s1"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
    `<saml:AttributeStatement>` +
    `<saml:Attribute Name="groups">${groups}</saml:Attribute>` +
    `<saml:Attribute Name="displayName"><saml:AttributeValue>Ada</saml:AttributeValue></saml:Attribute>` +
    `<saml:Attribute Name="email"><saml:AttributeValue>ada@acme.test</saml:AttributeValue></saml:Attribute>` +
    `</saml:AttributeStatement>` +
    `</saml:Assertion></samlp:Response>`;
  const mode = o.sign ?? 'assertion';
  if (mode === 'none') return Buffer.from(xml).toString('base64');
  const signed = signXml(
    xml,
    "//*[local-name(.)='Assertion']",
    { reference: "//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']", action: 'after' },
    {
      privateKey: mode === 'wrong-key' ? otherPrivateKey : idpPrivateKey,
      signatureAlgorithm: 'sha256',
      digestAlgorithm: 'sha256',
    },
  );
  return Buffer.from(signed).toString('base64');
}

function cookieVal(headers: Record<string, unknown>, name: string): string {
  const sc = headers['set-cookie'];
  const arr = Array.isArray(sc) ? (sc as string[]) : typeof sc === 'string' ? [sc] : [];
  for (const c of arr) {
    const m = new RegExp(`^${name}=([^;]+)`).exec(c);
    if (m?.[1]) return decodeURIComponent(m[1]);
  }
  return '';
}

function cookieAttrs(headers: Record<string, unknown>, name: string): string {
  const sc = headers['set-cookie'];
  const arr = Array.isArray(sc) ? (sc as string[]) : typeof sc === 'string' ? [sc] : [];
  return arr.find((c) => c.startsWith(`${name}=`)) ?? '';
}

let app: FastifyInstance;
let gadm: string;
let orgId: string;

function samlConfig(over: Partial<SamlSessionConfig> = {}): SamlSessionConfig {
  return {
    entryPoint: 'https://idp.test/sso',
    idpIssuer: IDP_ISSUER,
    idpCert: idpPublicKey,
    spEntityId: SP_ENTITY,
    callbackUrl: ACS,
    groupsAttribute: 'groups',
    subjectAttribute: 'NameID',
    roleRules: parseRoleMap('[{"group":"gulley-admins","role":"owner","orgId":"*"}]'),
    postLoginRedirect: '/',
    cookieSecure: false,
    allowIdpInitiated: false,
    wantAssertionsSigned: true,
    wantResponseSigned: false,
    acceptedClockSkewMs: 0,
    ...over,
  };
}

async function boot(over: Partial<SamlSessionConfig> = {}, env: Record<string, string> = {}) {
  gadm = `gadm_${randomBytes(24).toString('base64url')}`;
  const ctx = createInMemoryControlContext({
    pepper: 'saml-check-pepper-16chars-min!!',
    bootstrapEnabled: true,
    bootstrapTokenSha256: createHash('sha256').update(gadm).digest('hex'),
    sessionSecrets: [SESSION_SECRET],
    maxSessionTtlMs: 900_000,
    saml: samlConfig(over),
  });
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent', ...env } as NodeJS.ProcessEnv), ctx);
  const org = await app.inject({
    method: 'POST',
    url: '/orgs',
    headers: { authorization: `Bearer ${gadm}`, 'content-type': 'application/json' },
    payload: JSON.stringify({ name: 'Acme' }),
  });
  orgId = (org.json().org as { id: string }).id;
}

/** Start an SP-initiated flow: returns the AuthnRequest id, RelayState and flow cookie. */
async function startLogin(returnTo?: string) {
  const login = await app.inject({
    method: 'GET',
    url: returnTo
      ? `/auth/saml/login?return_to=${encodeURIComponent(returnTo)}`
      : '/auth/saml/login',
  });
  expect(login.statusCode).toBe(302);
  const url = new URL(login.headers['location'] as string);
  expect(url.origin + url.pathname).toBe('https://idp.test/sso');
  const relayState = url.searchParams.get('RelayState') as string;
  expect(relayState).toBeTruthy();
  expect(relayState.length).toBeLessThanOrEqual(80);
  const samlRequest = url.searchParams.get('SAMLRequest') as string;
  // The deflated AuthnRequest carries the id the flow expects; recover it.
  const { inflateRawSync } = await import('node:zlib');
  const xml = inflateRawSync(Buffer.from(samlRequest, 'base64')).toString();
  const requestId = /\sID="([^"]+)"/.exec(xml)?.[1] as string;
  expect(requestId).toMatch(/^_/);
  expect(xml).toContain(`AssertionConsumerServiceURL="${ACS}"`);
  const flowCookie = cookieVal(login.headers as Record<string, unknown>, 'gulley_saml_flow');
  expect(flowCookie).toBeTruthy();
  return {
    requestId,
    relayState,
    flowCookie,
    loginHeaders: login.headers as Record<string, unknown>,
  };
}

function acs(
  samlResponse: string,
  relayState: string | undefined,
  flowCookie: string | undefined,
  extra: Record<string, string> = {},
) {
  const body = new URLSearchParams({ SAMLResponse: samlResponse });
  if (relayState !== undefined) body.set('RelayState', relayState);
  return app.inject({
    method: 'POST',
    url: '/auth/saml/acs',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      // The IdP's form post is cross-site by design.
      'sec-fetch-site': 'cross-site',
      ...(flowCookie ? { cookie: `gulley_saml_flow=${encodeURIComponent(flowCookie)}` } : {}),
      ...extra,
    },
    payload: body.toString(),
  });
}

afterEach(async () => {
  await app.close();
});

describe('SAML session gate', () => {
  beforeEach(() => boot());

  it('/auth/config reports both gates and /admin/status the saml subsystem', async () => {
    const cfg = await app.inject({ method: 'GET', url: '/auth/config' });
    expect(cfg.json()).toMatchObject({
      enabled: true,
      loginUrl: '/auth/saml/login',
      oidc: { enabled: false },
      saml: { enabled: true, loginUrl: '/auth/saml/login' },
    });
    const status = await app.inject({
      method: 'GET',
      url: '/admin/status',
      headers: { authorization: `Bearer ${gadm}` },
    });
    expect((status.json() as { subsystems: Record<string, boolean> }).subsystems.saml).toBe(true);
  });

  it('serves SP metadata', async () => {
    const md = await app.inject({ method: 'GET', url: '/auth/saml/metadata' });
    expect(md.statusCode).toBe(200);
    expect(md.headers['content-type']).toContain('samlmetadata+xml');
    expect(md.body).toContain(`entityID="${SP_ENTITY}"`);
    expect(md.body).toContain(`Location="${ACS}"`);
    expect(md.body).toContain('WantAssertionsSigned="true"');
  });

  it('runs login → ACS → session with mapped memberships, through the CSRF hook', async () => {
    const { requestId, relayState, flowCookie, loginHeaders } = await startLogin(
      '/oauth/device?user_code=ABCD-EFGH',
    );
    // Dev edge (cookieSecure=false): the flow cookie omits SameSite (see saml-routes.ts).
    expect(cookieAttrs(loginHeaders, 'gulley_saml_flow')).not.toContain('SameSite');
    const res = await acs(samlResponse({ inResponseTo: requestId }), relayState, flowCookie);
    expect(res.statusCode).toBe(302);
    expect(res.headers['location']).toBe('/oauth/device?user_code=ABCD-EFGH');
    const session = cookieVal(res.headers as Record<string, unknown>, 'gulley_admin_session');
    expect(session).toBeTruthy();
    expect(cookieAttrs(res.headers as Record<string, unknown>, 'gulley_saml_flow')).toContain(
      'Max-Age=0',
    );

    const me = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie: `gulley_admin_session=${encodeURIComponent(session)}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      subject: 'ada@acme.test',
      name: 'Ada',
      memberships: [{ role: 'owner', orgId, workspaceId: null }],
    });
    // The session is usable on an admin route and recorded with source `saml`.
    const sessions = await app.inject({
      method: 'GET',
      url: '/admin/sessions',
      headers: { authorization: `Bearer ${gadm}` },
    });
    const list = (sessions.json() as { sessions: Array<{ subject: string; source: string }> })
      .sessions;
    expect(list.some((s) => s.subject === 'ada@acme.test' && s.source === 'saml')).toBe(true);
    const audit = await app.inject({
      method: 'GET',
      url: '/audit/events?limit=20',
      headers: { authorization: `Bearer ${gadm}` },
    });
    const events = (
      audit.json() as { events: Array<{ action: string; payload?: Record<string, unknown> }> }
    ).events;
    const row = events.find((e) => e.action === 'admin.session.saml');
    expect(row?.payload).toMatchObject({ memberships: 1, groups: 2, idpInitiated: false });
  });

  it('sets SameSite=None; Secure on the flow cookie when the cookie is secure', async () => {
    await app.close();
    await boot({ cookieSecure: true });
    const login = await app.inject({ method: 'GET', url: '/auth/saml/login' });
    const attrs = cookieAttrs(login.headers as Record<string, unknown>, 'gulley_saml_flow');
    expect(attrs).toContain('SameSite=None');
    expect(attrs).toContain('Secure');
  });

  it('rejects a wrong audience', async () => {
    const { requestId, relayState, flowCookie } = await startLogin();
    const res = await acs(
      samlResponse({ inResponseTo: requestId, audience: 'urn:someone:else' }),
      relayState,
      flowCookie,
    );
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toMatch(/audience/i);
  });

  it('rejects an expired assertion', async () => {
    const { requestId, relayState, flowCookie } = await startLogin();
    const res = await acs(
      samlResponse({ inResponseTo: requestId, notOnOrAfter: new Date(Date.now() - 1_000) }),
      relayState,
      flowCookie,
    );
    expect(res.statusCode).toBe(401);
  });

  it('rejects a not-yet-valid assertion', async () => {
    const { requestId, relayState, flowCookie } = await startLogin();
    const res = await acs(
      samlResponse({ inResponseTo: requestId, notBefore: new Date(Date.now() + 10 * 60_000) }),
      relayState,
      flowCookie,
    );
    expect(res.statusCode).toBe(401);
  });

  it('rejects a replayed assertion', async () => {
    const { requestId, relayState, flowCookie } = await startLogin();
    const response = samlResponse({ inResponseTo: requestId });
    expect((await acs(response, relayState, flowCookie)).statusCode).toBe(302);
    const again = await acs(response, relayState, flowCookie);
    expect(again.statusCode).toBe(401);
    expect(again.json().error.message).toMatch(/replayed/);
  });

  it('rejects an unsigned response and one signed by another key', async () => {
    const a = await startLogin();
    const unsigned = await acs(
      samlResponse({ inResponseTo: a.requestId, sign: 'none' }),
      a.relayState,
      a.flowCookie,
    );
    expect(unsigned.statusCode).toBe(401);
    expect(unsigned.json().error.message).toMatch(/signature/i);
    const b = await startLogin();
    const forged = await acs(
      samlResponse({ inResponseTo: b.requestId, sign: 'wrong-key' }),
      b.relayState,
      b.flowCookie,
    );
    expect(forged.statusCode).toBe(401);
  });

  it('rejects a wrong issuer and a wrong destination', async () => {
    const a = await startLogin();
    const issuer = await acs(
      samlResponse({ inResponseTo: a.requestId, issuer: 'https://evil.test' }),
      a.relayState,
      a.flowCookie,
    );
    expect(issuer.statusCode).toBe(401);
    expect(issuer.json().error.message).toMatch(/issuer/);
    const b = await startLogin();
    const dest = await acs(
      samlResponse({ inResponseTo: b.requestId, destination: 'http://other.test/acs' }),
      b.relayState,
      b.flowCookie,
    );
    expect(dest.statusCode).toBe(401);
    expect(dest.json().error.message).toMatch(/destination/);
  });

  it('binds the response to the browser flow: wrong InResponseTo, RelayState or no cookie fail', async () => {
    const { requestId, relayState, flowCookie } = await startLogin();
    // An assertion answering a different AuthnRequest id.
    expect(
      (await acs(samlResponse({ inResponseTo: '_someone_elses' }), relayState, flowCookie))
        .statusCode,
    ).toBe(401);
    // A RelayState from another flow.
    expect(
      (await acs(samlResponse({ inResponseTo: requestId }), 'other-state', flowCookie)).statusCode,
    ).toBe(400);
    // No flow cookie at all (and IdP-initiated off) — a login-CSRF attempt.
    expect(
      (await acs(samlResponse({ inResponseTo: requestId }), relayState, undefined)).statusCode,
    ).toBe(400);
  });

  it('refuses an IdP-initiated response unless enabled', async () => {
    const off = await acs(samlResponse({ inResponseTo: undefined }), undefined, undefined);
    expect(off.statusCode).toBe(400);
    await app.close();
    await boot({ allowIdpInitiated: true });
    const on = await acs(samlResponse({ inResponseTo: undefined }), '/analytics', undefined);
    expect(on.statusCode).toBe(302);
    expect(on.headers['location']).toBe('/analytics'); // RelayState as a same-origin landing path
    // Even when enabled, an unsolicited InResponseTo cannot answer a request that was never made.
    const stray = await acs(
      samlResponse({ inResponseTo: '_never_requested' }),
      undefined,
      undefined,
    );
    expect(stray.statusCode).toBe(401);
  });

  it('maps a custom role id through SAML_ROLE_MAP and the subject attribute', async () => {
    await app.close();
    await boot({
      roleRules: parseRoleMap('[{"group":"eng","role":"key-operator","orgId":"*"}]'),
      subjectAttribute: 'email',
    });
    const { requestId, relayState, flowCookie } = await startLogin();
    const res = await acs(
      samlResponse({ inResponseTo: requestId, nameId: 'opaque-id' }),
      relayState,
      flowCookie,
    );
    expect(res.statusCode).toBe(302);
    const session = cookieVal(res.headers as Record<string, unknown>, 'gulley_admin_session');
    const me = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie: `gulley_admin_session=${encodeURIComponent(session)}` },
    });
    expect(me.json()).toMatchObject({
      subject: 'ada@acme.test',
      memberships: [{ role: 'key-operator', orgId }],
    });
  });

  it('is 404 when SAML is not configured', async () => {
    await app.close();
    gadm = `gadm_${randomBytes(24).toString('base64url')}`;
    const ctx = createInMemoryControlContext({
      pepper: 'saml-check-pepper-16chars-min!!',
      bootstrapEnabled: true,
      bootstrapTokenSha256: createHash('sha256').update(gadm).digest('hex'),
      sessionSecrets: [SESSION_SECRET],
      maxSessionTtlMs: 900_000,
    });
    app = buildServer(loadConfig({ LOG_LEVEL: 'silent' } as NodeJS.ProcessEnv), ctx);
    expect((await app.inject({ method: 'GET', url: '/auth/saml/login' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/auth/config' })).json()).toMatchObject({
      enabled: false,
      saml: { enabled: false },
    });
  });
});

describe('saml-gate helpers', () => {
  it('responseDestination reads the root attribute only', () => {
    expect(
      responseDestination(
        `<?xml version="1.0"?>\n<samlp:Response xmlns:samlp="x" ID="a" Destination='http://acs'><a Destination="nested"/></samlp:Response>`,
      ),
    ).toBe('http://acs');
    expect(
      responseDestination('<samlp:Response ID="a"><a Destination="nested"/></samlp:Response>'),
    ).toBeUndefined();
    expect(responseDestination('not xml')).toBeUndefined();
  });

  it('ReplayGuard remembers ids until expiry and stays bounded', () => {
    const g = new ReplayGuard(3);
    expect(g.seen('a', 2_000, 1_000)).toBe(false);
    expect(g.seen('a', 2_000, 1_500)).toBe(true);
    expect(g.seen('a', 3_000, 2_500)).toBe(false); // expired → fresh
    g.seen('b', 9_000, 2_600);
    g.seen('c', 9_000, 2_600);
    g.seen('d', 9_000, 2_600); // forces a sweep + eviction
    expect(g.size).toBeLessThanOrEqual(3);
  });
});

describe('SAML config refinements', () => {
  it('requires the SP/IdP set when enabled and https + Secure in production', () => {
    expect(() => loadConfig({ SAML_ENABLED: 'true' })).toThrow(/SAML_IDP_ENTRY_POINT/);
    const base = {
      SAML_ENABLED: 'true',
      SAML_IDP_ENTRY_POINT: 'https://idp.test/sso',
      SAML_IDP_ISSUER: IDP_ISSUER,
      SAML_IDP_CERT: idpPublicKey,
      SAML_SP_ENTITY_ID: SP_ENTITY,
      SAML_SP_CALLBACK_URL: 'https://console.test/control/auth/saml/acs',
    };
    expect(() => loadConfig(base)).not.toThrow();
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow(/SAML_COOKIE_SECURE/);
    expect(() =>
      loadConfig({
        ...base,
        NODE_ENV: 'production',
        SAML_COOKIE_SECURE: 'true',
        SAML_SP_CALLBACK_URL: 'http://x/acs',
      }),
    ).toThrow(/https/);
    expect(() =>
      loadConfig({ ...base, NODE_ENV: 'production', SAML_COOKIE_SECURE: 'true' }),
    ).not.toThrow();
  });
});
