import { type CacheProvider, type Profile, SAML, ValidateInResponseTo } from '@node-saml/node-saml';
import { randomBytes } from 'node:crypto';
import type { SamlSessionConfig } from './context';

export const SAML_FLOW_COOKIE = 'gulley_saml_flow';

/** The SP-initiated flow state, HMAC-signed into the flow cookie (see signFlow in
 *  oidc-gate.ts). `state` is echoed by the IdP as RelayState; `requestId` is the
 *  AuthnRequest id the response's InResponseTo must name; `issuedAt` feeds the
 *  library's request-age check. */
export interface SamlFlow {
  state: string;
  requestId: string;
  issuedAt: string;
  returnTo: string;
  exp: number;
}

/** SAML ids must be XML NCNames: start with a letter or `_`. */
export function newSamlRequestId(): string {
  return `_${randomBytes(20).toString('hex')}`;
}

/** How long an AuthnRequest stays answerable (the flow cookie + InResponseTo window). */
export const SAML_FLOW_TTL_MS = 600_000;

export interface BuildSamlOptions {
  /** Login: the id to stamp on the AuthnRequest (so the flow can carry it). */
  requestId?: string;
  /** ACS: the one request id the response may answer, and when it was issued. */
  expected?: { requestId: string; issuedAt: string };
  /** ACS without a flow: accept a response that carries NO InResponseTo (IdP-initiated).
   *  One that does carry one still fails (there is no matching request). */
  idpInitiated?: boolean;
}

/**
 * A per-request SAML instance. node-saml validates InResponseTo through a
 * CacheProvider; ours answers for exactly the request id the signed flow carries, so
 * the check is stateless across replicas (the flow cookie is the store) and a
 * response can never answer a request from another browser's flow.
 */
export function buildSaml(cfg: SamlSessionConfig, opts: BuildSamlOptions = {}): SAML {
  const expected = opts.expected;
  const cache: CacheProvider = {
    saveAsync: async (_key, value) => ({ value, createdAt: Date.now() }),
    getAsync: async (key) => (expected && key === expected.requestId ? expected.issuedAt : null),
    removeAsync: async (key) => key,
  };
  return new SAML({
    callbackUrl: cfg.callbackUrl,
    entryPoint: cfg.entryPoint,
    issuer: cfg.spEntityId,
    audience: cfg.spEntityId,
    idpCert: cfg.idpCert,
    idpIssuer: cfg.idpIssuer,
    wantAssertionsSigned: cfg.wantAssertionsSigned,
    wantAuthnResponseSigned: cfg.wantResponseSigned,
    validateInResponseTo: opts.idpInitiated
      ? ValidateInResponseTo.ifPresent
      : ValidateInResponseTo.always,
    requestIdExpirationPeriodMs: SAML_FLOW_TTL_MS,
    cacheProvider: cache,
    acceptedClockSkewMs: cfg.acceptedClockSkewMs,
    // Entra rejects a RequestedAuthnContext it cannot satisfy (e.g. after MFA), and
    // the IdP's own policy decides the method anyway.
    disableRequestedAuthnContext: true,
    signatureAlgorithm: 'sha256',
    digestAlgorithm: 'sha256',
    ...(cfg.spPrivateKey ? { privateKey: cfg.spPrivateKey } : {}),
    ...(cfg.spCert ? { publicCert: cfg.spCert } : {}),
    ...(opts.requestId ? { generateUniqueId: () => opts.requestId! } : {}),
  });
}

/** The root `<Response Destination="…">` attribute, if present. node-saml does not
 *  check Destination; the SAML profile requires it to equal the ACS URL when set. A
 *  regex over the root start-tag only (never nested content). */
export function responseDestination(xml: string): string | undefined {
  const root = /<\s*(?:[\w.-]+:)?Response\b([^>]*)>/.exec(xml.replace(/^\s*<\?xml[^>]*>/, ''));
  if (!root) return undefined;
  const m = /\sDestination\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(root[1] ?? '');
  return m ? (m[1] ?? m[2]) : undefined;
}

/**
 * Bounded TTL set of seen assertion ids: a bearer assertion presented twice is a
 * replay (the InResponseTo check alone would admit it while the flow is live).
 * Per-process; with several replicas and no sticky sessions, pin NotOnOrAfter short
 * at the IdP (a few minutes) — a shared store is the documented follow-up.
 */
export class ReplayGuard {
  private readonly seenUntil = new Map<string, number>();
  constructor(private readonly max = 50_000) {}

  /** Record `id`; true when it was already present (a replay). */
  seen(id: string, expiresAtMs: number, nowMs: number): boolean {
    this.sweep(nowMs);
    const until = this.seenUntil.get(id);
    if (until !== undefined && until > nowMs) return true;
    this.seenUntil.set(id, expiresAtMs);
    return false;
  }

  get size(): number {
    return this.seenUntil.size;
  }

  private sweep(nowMs: number): void {
    if (this.seenUntil.size < this.max) return;
    for (const [k, until] of this.seenUntil) if (until <= nowMs) this.seenUntil.delete(k);
    // Still full of live entries: drop the oldest-expiring so the set stays bounded.
    if (this.seenUntil.size >= this.max) {
      const first = this.seenUntil.keys().next();
      if (!first.done) this.seenUntil.delete(first.value);
    }
  }
}

// --- profile readers ---

type Attr = string | string[] | Record<string, unknown> | undefined;

function strings(v: unknown): string[] {
  if (typeof v === 'string') return v.length > 0 ? [v] : [];
  if (Array.isArray(v)) return v.flatMap((x) => (typeof x === 'string' && x.length > 0 ? [x] : []));
  return [];
}

function attribute(profile: Profile, name: string): Attr {
  const attrs = profile.attributes as Record<string, unknown> | undefined;
  const v = attrs?.[name] ?? profile[name];
  return typeof v === 'string' || Array.isArray(v) || (v && typeof v === 'object')
    ? (v as Attr)
    : undefined;
}

const ENTRA_GROUPS = 'http://schemas.microsoft.com/ws/2008/06/identity/claims/groups';
const ENTRA_ROLE = 'http://schemas.microsoft.com/ws/2008/06/identity/claims/role';

/** Group values for role mapping: the configured attribute UNIONED with the common
 *  group/role attribute names (Entra's claims URIs, `groups`, `roles`) — mirroring the
 *  OIDC gate, so one SAML_ROLE_MAP rule can name an App Role or a group. */
export function samlGroups(profile: Profile, attributeName: string): string[] {
  const out = new Set<string>();
  for (const key of [attributeName, 'groups', 'roles', 'role', ENTRA_GROUPS, ENTRA_ROLE]) {
    for (const s of strings(attribute(profile, key))) out.add(s);
  }
  return [...out];
}

/** The admin subject: NameID (default) or a named attribute. Empty ⇒ undefined. */
export function samlSubject(profile: Profile, attributeName: string): string | undefined {
  if (attributeName === 'NameID' || attributeName === 'nameID') {
    return typeof profile.nameID === 'string' && profile.nameID.length > 0
      ? profile.nameID
      : undefined;
  }
  return strings(attribute(profile, attributeName))[0];
}

const NAME_ATTRS = [
  'displayName',
  'name',
  'http://schemas.microsoft.com/identity/claims/displayname',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name',
  'cn',
];
const EMAIL_ATTRS = [
  'email',
  'mail',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
  'emailAddress',
];

export function samlDisplayName(profile: Profile): string | undefined {
  for (const k of NAME_ATTRS) {
    const v = strings(attribute(profile, k))[0];
    if (v) return v;
  }
  return undefined;
}

export function samlEmail(profile: Profile): string | undefined {
  for (const k of EMAIL_ATTRS) {
    const v = strings(attribute(profile, k))[0];
    if (v) return v;
  }
  return undefined;
}

/** Assertion id + the latest NotOnOrAfter (Conditions / SubjectConfirmationData),
 *  read from node-saml's parsed assertion for the replay guard's TTL. */
export function assertionMeta(profile: Profile): { id?: string; notOnOrAfterMs?: number } {
  const parsed = profile.getAssertion?.() as { Assertion?: Record<string, unknown> } | undefined;
  const a = parsed?.Assertion;
  if (!a) return {};
  const attrs = a['$'] as Record<string, unknown> | undefined;
  const id = typeof attrs?.['ID'] === 'string' ? (attrs['ID'] as string) : undefined;
  const whens: number[] = [];
  const push = (v: unknown): void => {
    if (typeof v === 'string') {
      const t = Date.parse(v);
      if (Number.isFinite(t)) whens.push(t);
    }
  };
  const conditions = a['Conditions'] as Array<{ $?: Record<string, unknown> }> | undefined;
  for (const c of conditions ?? []) push(c.$?.['NotOnOrAfter']);
  const subject = a['Subject'] as
    | Array<{
        SubjectConfirmation?: Array<{
          SubjectConfirmationData?: Array<{ $?: Record<string, unknown> }>;
        }>;
      }>
    | undefined;
  for (const s of subject ?? [])
    for (const sc of s.SubjectConfirmation ?? [])
      for (const d of sc.SubjectConfirmationData ?? []) push(d.$?.['NotOnOrAfter']);
  return {
    ...(id ? { id } : {}),
    ...(whens.length > 0 ? { notOnOrAfterMs: Math.max(...whens) } : {}),
  };
}
