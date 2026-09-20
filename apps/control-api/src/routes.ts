import { type AdminSessionClaims, signAdminSession } from '@gulley/auth';
import {
  assertNoInlineSecret,
  verifyAttestation,
  verifyAttestationWithPublicKey,
} from '@gulley/pipeline';
import { MissingVariablesError, PromptNameConflictError, renderPrompt } from '@gulley/prompts';
import {
  type ClientAgent,
  type ClientAuthMode,
  buildOnboardingManifest,
  generateClientConfig,
  publicKeyOf,
  signOnboardingPack,
} from '@gulley/cli';
import { GULLEY_VERSION, secretRef } from '@gulley/core';
import { assertEgressAllowed, EgressError } from '@gulley/egress';
import {
  can,
  coveredOrgIds,
  isRole,
  type Membership as RbacMembership,
  maxRankAt,
  type Permission,
  roleRank,
} from '@gulley/rbac';
import { randomUUID } from 'node:crypto';
import {
  adminRoute,
  auditedWrite,
  body,
  clampTtlSeconds,
  configHash,
  forbidden,
  isUuid,
  notFound,
  scopeForProvider,
  scopeForWorkspace,
  str,
  strMax,
  uuidParam,
  visibleWorkspaceIds,
} from './admin';
import { detectChainRewrite } from './anchor';
import { consoleWrite } from './durable-config';
import { signCtxAttestation } from './audit-signing';
import { buildEvidenceBundle } from './evidence-bundle';
import type { ControlContext } from './context';
import { publicOrigin } from './oauth-routes';
import type { CollectionKind } from './domain';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

function invalid(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(422).send({ error: { type: 'validation', message } });
}

function paramId(request: { params: unknown }): string {
  return (request.params as { id: string }).id;
}

function conflict(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(409).send({ error: { type: 'conflict', message } });
}

function nameTaken(
  ctx: ControlContext,
  kind: CollectionKind,
  workspaceId: string,
  name: string,
): boolean {
  return ctx.collections[kind].all().some((e) => e.workspaceId === workspaceId && e.name === name);
}

const MAX_LABEL = 128;
const MAX_REASON = 1_024;
const MAX_DELEGATED_MEMBERSHIPS = 50;

export function registerAdminRoutes(app: FastifyInstance, ctx: ControlContext): void {
  // --- admin session minting (delegated, scoped tokens; no amplification) ---
  // The token's subject is ALWAYS the minting admin: a caller-chosen `subject` used to
  // become the session's identity, so an org admin could mint `{subject: <platform
  // owner>, memberships: []}` — no permission check ran (the loop was empty), the
  // durable membership loader then unioned the named subject's grants in, and every
  // audit row it wrote named someone else. Now: sub = minter, the delegated
  // memberships are the token's whole authority (the resolver skips the loader for
  // `exchange` tokens), at least one membership is required (so a can() check always
  // runs), and the caller's label survives only as the display name.
  app.post(
    '/admin/sessions',
    adminRoute(ctx, async (request, reply, admin) => {
      const b = body(request);
      const label = strMax(b['name'] ?? b['subject'], MAX_LABEL);
      if ((b['name'] !== undefined || b['subject'] !== undefined) && label === undefined)
        return invalid(reply, `name must be 1..${MAX_LABEL} characters`);
      const subject = admin.subject;
      const name = label ?? `delegated:${admin.displayName}`;
      const maxTtl = ctx.resolverDeps.maxSessionTtlMs / 1000;
      const ttlSeconds = clampTtlSeconds(b['ttlSeconds'], 900, maxTtl);
      const rawMemberships = Array.isArray(b['memberships']) ? b['memberships'] : [];
      if (rawMemberships.length === 0) return invalid(reply, 'at least one membership is required');
      if (rawMemberships.length > MAX_DELEGATED_MEMBERSHIPS)
        return invalid(reply, `at most ${MAX_DELEGATED_MEMBERSHIPS} memberships`);

      const memberships: RbacMembership[] = [];
      for (const m of rawMemberships) {
        const mm = (m ?? {}) as Record<string, unknown>;
        const role = mm['role'];
        const orgId = str(mm['orgId']);
        const workspaceId = str(mm['workspaceId']) ?? null;
        if (!isRole(role) || !orgId) return invalid(reply, 'bad membership');
        const at = { orgId, workspaceId };
        if (!can(admin, 'membership:create', at)) return forbidden(reply);
        if (role === 'owner' && !can(admin, 'membership:grant_owner', at)) return forbidden(reply);
        if (roleRank[role] > maxRankAt(admin, at)) return forbidden(reply); // no amplification
        memberships.push({ role, orgId, workspaceId });
      }

      const secret = ctx.resolverDeps.sessionSecrets[0];
      if (!secret)
        return reply.code(500).send({ error: { type: 'config', message: 'no session secret' } });
      const now = ctx.resolverDeps.now ?? Date.now();
      const iat = Math.floor(now / 1000);
      const jti = randomUUID();
      const claims: AdminSessionClaims = {
        sub: subject,
        name,
        jti,
        memberships,
        iat,
        exp: iat + ttlSeconds,
        typ: 'admin-session',
        ver: 1,
        src: 'exchange',
      };
      const token = signAdminSession(secret, claims);
      await ctx.sessions.record?.({
        jti,
        subject,
        source: 'exchange',
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(claims.exp * 1000).toISOString(),
      });
      await ctx.audit.append({
        orgId: null,
        actor: admin.subject,
        action: 'admin.session.mint',
        target: subject,
        payload: { jti, label: name, memberships, ttlSeconds },
      });
      return reply.code(201).send({ token, expiresAt: new Date(claims.exp * 1000).toISOString() });
    }),
  );

  // --- break-glass: audited, time-boxed emergency elevation ---
  // The static bootstrap token is long-lived, unscoped-owner, and its use is not
  // itself audited. Break-glass is the disciplined path: exchange the bootstrap token
  // (bootstrap-ONLY — a regular session can't self-elevate) for a SHORT-lived
  // owner@* session with a REQUIRED reason, recorded as a first-class audit event. The
  // session auto-expires (and is revocable by jti), so emergency access is bounded
  // and traceable rather than a permanent all-powerful credential.
  app.post(
    '/admin/break-glass',
    adminRoute(ctx, async (request, reply, admin) => {
      if (admin.source !== 'bootstrap') return forbidden(reply);
      const b = body(request);
      const reason = strMax(b['reason'], MAX_REASON);
      if (!reason) return invalid(reply, `reason required (1..${MAX_REASON} characters)`);
      const secret = ctx.resolverDeps.sessionSecrets[0];
      if (!secret)
        return reply.code(500).send({ error: { type: 'config', message: 'no session secret' } });
      const cap = ctx.resolverDeps.maxSessionTtlMs / 1000;
      const ttlSeconds = clampTtlSeconds(b['ttlSeconds'], 900, cap);
      const now = ctx.resolverDeps.now ?? Date.now();
      const iat = Math.floor(now / 1000);
      const jti = randomUUID();
      const claims: AdminSessionClaims = {
        sub: `break-glass:${admin.subject}`,
        name: 'break-glass',
        src: 'break-glass',
        jti,
        memberships: [{ role: 'owner', orgId: '*' }],
        iat,
        exp: iat + ttlSeconds,
        typ: 'admin-session',
        ver: 1,
      };
      const token = signAdminSession(secret, claims);
      const expiresAt = new Date(claims.exp * 1000).toISOString();
      await ctx.sessions.record?.({
        jti,
        subject: claims.sub,
        source: 'break-glass',
        createdAt: new Date(now).toISOString(),
        expiresAt,
      });
      await ctx.audit.append({
        orgId: null,
        actor: admin.subject,
        action: 'admin.break_glass',
        target: jti,
        payload: { reason, expiresAt, ttlSeconds },
      });
      return reply.code(201).send({ token, expiresAt });
    }),
  );

  // --- orgs ---
  app.get(
    '/orgs',
    adminRoute(ctx, async (_req, reply, admin) =>
      reply.send({ orgs: ctx.orgs.list(coveredOrgIds(admin)) }),
    ),
  );
  app.post(
    '/orgs',
    adminRoute(ctx, async (request, reply, admin) => {
      const name = str(body(request)['name']);
      if (!name) return invalid(reply, 'name required');
      const r = await auditedWrite(ctx, admin, {
        perm: 'org:create',
        at: {},
        action: 'org.create',
        target: 'org',
        diff: { name },
        mutate: () => ctx.orgs.create(name),
      });
      return r.ok ? reply.code(201).send({ org: r.value }) : forbidden(reply);
    }),
  );
  app.delete(
    '/orgs/:id',
    adminRoute(ctx, async (request, reply, admin) => {
      const id = paramId(request);
      const r = await auditedWrite(ctx, admin, {
        perm: 'org:delete',
        at: { orgId: id },
        action: 'org.delete',
        target: id,
        diff: { orgId: id },
        mutate: async () => {
          const deleted = await ctx.orgs.delete(id);
          // Postgres cascades org → workspace; mirror that in the read model.
          if (deleted) ctx.workspaces.deleteByOrg(id);
          return deleted;
        },
      });
      return r.ok ? reply.send({ deleted: r.value }) : forbidden(reply);
    }),
  );

  // --- workspaces ---
  app.get(
    '/workspaces',
    adminRoute(ctx, async (_req, reply, admin) => {
      const visible = visibleWorkspaceIds(ctx, admin);
      return reply.send({ workspaces: ctx.workspaces.list('*').filter((w) => visible.has(w.id)) });
    }),
  );
  app.post(
    '/workspaces',
    adminRoute(ctx, async (request, reply, admin) => {
      const b = body(request);
      const orgId = str(b['orgId']);
      const name = str(b['name']);
      if (!orgId || !name) return invalid(reply, 'orgId and name required');
      if (!ctx.orgs.get(orgId)) return notFound(reply, 'org');
      const r = await auditedWrite(ctx, admin, {
        perm: 'workspace:create',
        at: { orgId },
        action: 'workspace.create',
        target: orgId,
        diff: { orgId, name },
        mutate: () => ctx.workspaces.create(orgId, name),
      });
      return r.ok ? reply.code(201).send({ workspace: r.value }) : forbidden(reply);
    }),
  );

  // --- providers + credential (secret-ref only) ---
  app.get(
    '/providers',
    adminRoute(ctx, async (_req, reply, admin) => {
      const visible = visibleWorkspaceIds(ctx, admin);
      return reply.send({
        providers: ctx.providers.all().filter((p) => visible.has(p.workspaceId)),
      });
    }),
  );
  app.post(
    '/providers',
    adminRoute(ctx, async (request, reply, admin) => {
      const b = body(request);
      const workspaceId = str(b['workspaceId']);
      const kind = str(b['kind']);
      const baseUrl = str(b['baseUrl']);
      if (!workspaceId || !kind) return invalid(reply, 'workspaceId and kind required');
      const at = scopeForWorkspace(ctx, workspaceId);
      if (!at) return notFound(reply, 'workspace');
      if (baseUrl) {
        try {
          assertEgressAllowed(baseUrl, { allowlist: ctx.outboundAllowlist });
        } catch (e) {
          return reply.code(422).send({
            error: {
              type: 'egress',
              message: 'baseUrl is not an allowed egress destination',
              reason: e instanceof EgressError ? e.reason : 'blocked',
            },
          });
        }
      }
      const r = await consoleWrite(ctx, admin, {
        perm: 'provider:create',
        at,
        action: 'provider.create',
        target: workspaceId,
        diff: { kind, baseUrl: baseUrl ?? null },
        memory: () =>
          ctx.providers.create({ workspaceId, kind, baseUrl: baseUrl ?? null, enabled: true }),
        // Providers reconcile by kind (one per workspace): the durable create is an upsert.
        durable: async (b) => {
          const p = await b.upsertProvider(workspaceId, {
            kind,
            baseUrl: baseUrl ?? null,
            enabled: true,
            region: null,
            zdr: false,
          });
          return { id: p.id, workspaceId, kind: p.kind, baseUrl: p.baseUrl, enabled: p.enabled };
        },
      });
      return r.ok ? reply.code(201).send({ provider: r.value }) : forbidden(reply);
    }),
  );
  app.post(
    '/providers/:id/credential',
    adminRoute(ctx, async (request, reply, admin) => {
      const id = paramId(request);
      const b = body(request);
      const secretArn = str(b['secretArn']);
      const secretVersion = str(b['secretVersion']);
      if (!secretArn || !secretVersion)
        return invalid(reply, 'secretArn and secretVersion required');
      const at = scopeForProvider(ctx, id);
      if (!at) return notFound(reply, 'provider');
      let ref;
      try {
        ref = secretRef(secretArn, secretVersion);
      } catch (e) {
        return invalid(reply, (e as Error).message);
      }
      const r = await consoleWrite(ctx, admin, {
        perm: 'provider:update',
        at,
        action: 'provider.credential.set',
        target: id,
        diff: { credential: ref },
        memory: () => ctx.credentials.set(id, ref),
        durable: async (b) => {
          await b.setCredential(id, ref);
          return { id, providerId: id, credential: ref };
        },
      });
      return r.ok
        ? reply
            .code(201)
            .send({ credential: { id: r.value.id, providerId: id, secretArn, secretVersion } })
        : forbidden(reply);
    }),
  );

  // --- memberships (no privilege amplification; owner grants owner-only) ---
  app.post(
    '/memberships',
    adminRoute(ctx, async (request, reply, admin) => {
      const b = body(request);
      // Durable RBAC (DB mode) grants by SUBJECT (the identity a session carries) —
      // the admin_user is upserted so the grant is effective at the subject's next
      // auth. The in-memory path keeps the legacy opaque `userId`. Either way the
      // grant requires membership:create, owner needs grant_owner, and no role may
      // exceed the granter's rank at the scope (anti-amplification).
      const subject = strMax(b['subject'], 512);
      const userId = str(b['userId']);
      const role = b['role'];
      const orgId = str(b['orgId']);
      const workspaceId = str(b['workspaceId']) ?? null;
      if (!isRole(role) || !orgId) return invalid(reply, 'role, orgId required');
      // orgId "*" is a PLATFORM grant: it is checked at the empty deployment scope (only
      // a platform-wide membership covers it) and persisted as NULL org (the uuid column
      // cannot hold the sentinel — it used to 500 in DB mode).
      const platform = orgId === '*';
      if (platform && workspaceId) return invalid(reply, 'a platform grant has no workspace');
      const at = platform ? {} : { orgId, workspaceId };
      if (!can(admin, 'membership:create', at)) return forbidden(reply);
      if (role === 'owner' && !can(admin, 'membership:grant_owner', at)) return forbidden(reply);
      if (roleRank[role] > maxRankAt(admin, at)) return forbidden(reply);
      if (!platform && !isUuid(orgId) && ctx.durableMemberships)
        return invalid(reply, 'orgId must be a uuid');
      if (workspaceId && !isUuid(workspaceId) && ctx.durableMemberships)
        return invalid(reply, 'workspaceId must be a uuid');

      if (ctx.durableMemberships && ctx.adminUsers) {
        if (!subject && !userId) return invalid(reply, 'subject (or userId) required');
        if (!subject && userId && !isUuid(userId)) return invalid(reply, 'userId must be a uuid');
        const durableOrg = platform ? null : orgId;
        const displayName = strMax(b['displayName'], 256) ?? subject;
        // The grant and its audit row commit together (DB mode).
        const run = async (tx: {
          adminUsers: typeof ctx.adminUsers;
          memberships: typeof ctx.durableMemberships;
          audit: typeof ctx.audit;
        }) => {
          const uid = subject
            ? (await tx.adminUsers!.upsertBySubject(subject, displayName ?? subject)).id
            : userId!;
          const created = await tx.memberships!.create(uid, role, durableOrg, workspaceId);
          await tx.audit.append({
            orgId: durableOrg,
            actor: admin.subject,
            action: 'membership.create',
            target: subject ?? uid,
            payload: { role, orgId, workspaceId, subject },
          });
          return created;
        };
        const created = ctx.durableAtomic
          ? await ctx.durableAtomic((tx) => run(tx))
          : await run({
              adminUsers: ctx.adminUsers,
              memberships: ctx.durableMemberships,
              audit: ctx.audit,
            });
        return reply.code(201).send({ membership: created });
      }

      if (!userId) return invalid(reply, 'userId required');
      const created = ctx.memberships.create({ userId, role, orgId, workspaceId });
      await ctx.audit.append({
        orgId: platform ? null : orgId,
        actor: admin.subject,
        action: 'membership.create',
        target: userId,
        payload: { role, orgId, workspaceId },
      });
      return reply.code(201).send({ membership: created });
    }),
  );
  // List role grants visible to the caller (durable in DB mode, else the in-memory
  // ledger). A membership row is now authoritative for authz, so listing it matters.
  app.get(
    '/memberships',
    adminRoute(ctx, async (_request, reply, admin) => {
      const orgIds = coveredOrgIds(admin);
      const memberships = ctx.durableMemberships
        ? await ctx.durableMemberships.list(orgIds)
        : ctx.memberships.list(orgIds);
      return reply.send({ memberships });
    }),
  );
  // Revoke a durable role grant (DB mode) — effective at the subject's next request
  // (membershipLoader stops returning it), not only on token expiry.
  app.delete(
    '/memberships/:id',
    adminRoute(ctx, async (request, reply, admin) => {
      if (!ctx.durableMemberships) {
        return reply.code(501).send({
          error: { type: 'not_supported', message: 'durable memberships require a database' },
        });
      }
      if (!can(admin, 'membership:delete', {})) return forbidden(reply);
      const id = uuidParam(request);
      if (!id) return notFound(reply, 'membership');
      const durable = ctx.durableMemberships;
      const deleted = ctx.durableAtomic
        ? await ctx.durableAtomic(async (tx) => {
            const ok = await tx.memberships.delete(id);
            if (ok)
              await tx.audit.append({
                actor: admin.subject,
                action: 'membership.delete',
                target: id,
                payload: {},
              });
            return ok;
          })
        : await (async () => {
            const ok = await durable.delete(id);
            if (ok)
              await ctx.audit.append({
                actor: admin.subject,
                action: 'membership.delete',
                target: id,
                payload: {},
              });
            return ok;
          })();
      if (!deleted) return notFound(reply, 'membership');
      return reply.send({ deleted: true });
    }),
  );

  // --- virtual keys (token returned once; never stored/echoed) ---
  app.post(
    '/keys',
    adminRoute(ctx, async (request, reply, admin) => {
      const b = body(request);
      const workspaceId = str(b['workspaceId']);
      const name = str(b['name']) ?? 'key';
      if (!workspaceId) return invalid(reply, 'workspaceId required');
      const ws = ctx.workspaces.get(workspaceId);
      if (!ws) return notFound(reply, 'workspace');
      const at = { orgId: ws.orgId, workspaceId };
      if (!(await ctx.access.can(admin, 'key:create', at))) return forbidden(reply);
      const minted = await ctx.keys.mint({ workspaceId, orgId: ws.orgId, name });
      await ctx.audit.append({
        orgId: ws.orgId,
        actor: admin.subject,
        action: 'key.mint',
        target: minted.id,
        payload: { name, keyPrefix: minted.keyPrefix },
      });
      return reply
        .code(201)
        .send({ id: minted.id, token: minted.token, keyPrefix: minted.keyPrefix });
    }),
  );
  app.get(
    '/keys/:id',
    adminRoute(ctx, async (request, reply, admin) => {
      const id = uuidParam(request);
      const view = id ? await ctx.keys.get(id) : undefined;
      if (!view) return notFound(reply, 'key');
      const at = scopeForWorkspace(ctx, view.workspaceId) ?? {};
      if (!(await ctx.access.can(admin, 'key:read', at))) return forbidden(reply);
      return reply.send({ key: view });
    }),
  );
  // List a workspace's keys (secret-free views).
  app.get(
    '/keys',
    adminRoute(ctx, async (request, reply, admin) => {
      const workspaceId = str((request.query as Record<string, unknown>)?.['workspaceId']);
      if (!workspaceId) return invalid(reply, 'workspaceId required');
      const ws = ctx.workspaces.get(workspaceId);
      if (!ws) return notFound(reply, 'workspace');
      if (!(await ctx.access.can(admin, 'key:read', { orgId: ws.orgId, workspaceId })))
        return forbidden(reply);
      const keys = (await ctx.keys.list([ws.orgId])).filter((k) => k.workspaceId === workspaceId);
      return reply.send({ keys });
    }),
  );
  // The union of a workspace's model-policy allow-lists (surfaced to the developer;
  // the gateway is the authority that enforces the policy).
  const allowedModelsFor = (c: ControlContext, workspaceId: string): string[] => {
    const allow = new Set<string>();
    for (const e of c.collections['policy'].all()) {
      if (e.workspaceId !== workspaceId) continue;
      const a = e.config['allow'];
      if (Array.isArray(a)) for (const m of a) if (typeof m === 'string') allow.add(m);
    }
    return [...allow];
  };
  // ?agent=claude-code|codex  ?auth=virtual-key|oauth  ?clientId=...  ?profile=...
  // OAuth mode points the agent's token helper at THIS control plane (the broker).
  const clientSelection = (
    c: ControlContext,
    request: FastifyRequest,
  ): {
    agent: ClientAgent;
    auth: ClientAuthMode;
    brokerUrl: string;
    clientId?: string;
    profile?: string;
  } => {
    const q = (request.query ?? {}) as Record<string, unknown>;
    const agent: ClientAgent = str(q['agent']) === 'codex' ? 'codex' : 'claude-code';
    const auth: ClientAuthMode = str(q['auth']) === 'oauth' ? 'oauth' : 'virtual-key';
    return {
      agent,
      auth,
      brokerUrl: publicOrigin(c, request),
      clientId: str(q['clientId']),
      profile: str(q['profile']),
    };
  };
  // Generate a turnkey client config (Claude Code / Codex) for a workspace: the
  // gateway base URL + the team's allowed models (union of its model-access policy
  // allow-lists). The gateway is the authority that enforces the policy; this just
  // makes onboarding a base-URL change. The virtual-key SECRET is never emitted.
  app.get(
    '/admin/workspaces/:id/client-config',
    adminRoute(ctx, async (request, reply, admin) => {
      if (!ctx.gatewayPublicUrl) {
        return reply.code(501).send({
          error: { type: 'not_supported', message: 'GATEWAY_PUBLIC_URL not configured' },
        });
      }
      const workspaceId = paramId(request);
      const ws = ctx.workspaces.get(workspaceId);
      if (!ws) return notFound(reply, 'workspace');
      if (!visibleWorkspaceIds(ctx, admin).has(workspaceId)) return forbidden(reply);
      const sel = clientSelection(ctx, request);
      const config = generateClientConfig({
        ...sel,
        gatewayUrl: ctx.gatewayPublicUrl,
        allowedModels: allowedModelsFor(ctx, workspaceId),
      });
      return reply.send({ config });
    }),
  );

  // Signed onboarding pack: the client config wrapped in an Ed25519-signed manifest
  // so `gulley init` can verify authenticity (against the org's published public key)
  // before writing any settings — a phished/tampered pack is rejected. Needs both a
  // gateway public URL and a signing key.
  app.get(
    '/admin/workspaces/:id/onboarding-pack',
    adminRoute(ctx, async (request, reply, admin) => {
      if (!ctx.gatewayPublicUrl || !ctx.onboardingSigningKey) {
        return reply.code(501).send({
          error: {
            type: 'not_supported',
            message: 'onboarding packs require GATEWAY_PUBLIC_URL and ONBOARDING_SIGNING_KEY',
          },
        });
      }
      const workspaceId = paramId(request);
      const ws = ctx.workspaces.get(workspaceId);
      if (!ws) return notFound(reply, 'workspace');
      if (!visibleWorkspaceIds(ctx, admin).has(workspaceId)) return forbidden(reply);
      const sel = clientSelection(ctx, request);
      const manifest = buildOnboardingManifest({
        ...sel,
        gatewayUrl: ctx.gatewayPublicUrl,
        allowedModels: allowedModelsFor(ctx, workspaceId),
        issuedFor: ws.name,
        issuedAt: new Date().toISOString(),
      });
      const pack = signOnboardingPack(manifest, ctx.onboardingSigningKey);
      await ctx.audit.append({
        orgId: ws.orgId,
        actor: admin.subject,
        action: 'onboarding.pack.issue',
        target: workspaceId,
        payload: { agent: sel.agent, auth: sel.auth, issuedFor: ws.name },
      });
      return reply.send({ pack });
    }),
  );
  // The org's onboarding public key — PUBLIC (no auth), so a developer's `gulley init`
  // can fetch it out-of-band to verify a pack's signature.
  app.get('/.well-known/gulley-onboarding-key', async (_request, reply) => {
    if (!ctx.onboardingSigningKey) {
      return reply.code(404).send({ error: { type: 'not_found', message: 'no onboarding key' } });
    }
    return reply.send({ alg: 'ed25519', publicKey: publicKeyOf(ctx.onboardingSigningKey) });
  });

  // Revoke (disable) a key — effective on the gateway's next lookup.
  app.post(
    '/keys/:id/disable',
    adminRoute(ctx, async (request, reply, admin) => {
      const id = uuidParam(request);
      const view = id ? await ctx.keys.get(id) : undefined;
      if (!view) return notFound(reply, 'key');
      const at = scopeForWorkspace(ctx, view.workspaceId) ?? {};
      if (!(await ctx.access.can(admin, 'key:create', at))) return forbidden(reply);
      const updated = await ctx.keys.disable(view.id);
      await ctx.audit.append({
        orgId: at.orgId ?? null,
        actor: admin.subject,
        action: 'key.disable',
        target: view.id,
        payload: { keyPrefix: view.keyPrefix },
      });
      return reply.send({ key: updated });
    }),
  );
  // Rotate a key's secret (new token, same id).
  app.post(
    '/keys/:id/rotate',
    adminRoute(ctx, async (request, reply, admin) => {
      const id = uuidParam(request);
      const view = id ? await ctx.keys.get(id) : undefined;
      if (!view) return notFound(reply, 'key');
      const at = scopeForWorkspace(ctx, view.workspaceId) ?? {};
      if (!(await ctx.access.can(admin, 'key:create', at))) return forbidden(reply);
      const rotated = await ctx.keys.rotate(view.id);
      await ctx.audit.append({
        orgId: at.orgId ?? null,
        actor: admin.subject,
        action: 'key.rotate',
        target: view.id,
        payload: { keyPrefix: rotated?.keyPrefix },
      });
      return reply.send({ id: view.id, token: rotated?.token, keyPrefix: rotated?.keyPrefix });
    }),
  );

  // --- workspace-scoped config collections (serialized by GitOps in M5.3) ---
  const collections: Array<{ path: string; kind: CollectionKind; resource: string }> = [
    { path: 'routes', kind: 'route', resource: 'route' },
    { path: 'policies', kind: 'policy', resource: 'policy' },
    { path: 'budgets', kind: 'budget', resource: 'budget' },
    { path: 'rate-limits', kind: 'ratelimit', resource: 'ratelimit' },
    { path: 'guardrails', kind: 'guardrail', resource: 'guardrail' },
    { path: 'model-aliases', kind: 'modelalias', resource: 'route' },
  ];
  for (const c of collections) {
    app.post(
      `/${c.path}`,
      adminRoute(ctx, async (request, reply, admin) => {
        const b = body(request);
        const workspaceId = str(b['workspaceId']);
        const name = str(b['name']);
        const config =
          b['config'] && typeof b['config'] === 'object'
            ? (b['config'] as Record<string, unknown>)
            : {};
        if (!workspaceId || !name) return invalid(reply, 'workspaceId and name required');
        const at = scopeForWorkspace(ctx, workspaceId);
        if (!at) return notFound(reply, 'workspace');
        try {
          assertNoInlineSecret(config);
        } catch (e) {
          return reply
            .code(422)
            .send({ error: { type: 'inline_secret', message: (e as Error).message } });
        }
        // Names are the GitOps reconcile key within a workspace: a duplicate would make
        // export/apply ambiguous (budget is singular per workspace and upserts instead).
        if (c.kind !== 'budget' && nameTaken(ctx, c.kind, workspaceId, name))
          return conflict(reply, `${c.resource} "${name}" already exists in this workspace`);
        const r = await consoleWrite(ctx, admin, {
          perm: `${c.resource}:create` as Permission,
          at,
          action: `${c.kind}.create`,
          target: workspaceId,
          diff: { name },
          memory: () => ctx.collections[c.kind].create(workspaceId, name, config),
          durable: async (b) => ({
            id: await b.createEntityReturning(c.kind, workspaceId, name, config),
            workspaceId,
            name,
            config,
          }),
        });
        return r.ok ? reply.code(201).send({ entity: r.value }) : forbidden(reply);
      }),
    );
    app.get(
      `/${c.path}`,
      adminRoute(ctx, async (_req, reply, admin) => {
        const visible = visibleWorkspaceIds(ctx, admin);
        const entities = ctx.collections[c.kind].all().filter((e) => visible.has(e.workspaceId));
        return reply.send({ entities });
      }),
    );
    // Update (name and/or config) — scope resolved from the stored entity's
    // workspace, never the request body, so a caller can't forge an orgId.
    app.put(
      `/${c.path}/:id`,
      adminRoute(ctx, async (request, reply, admin) => {
        const id = paramId(request);
        const existing = ctx.collections[c.kind].get(id);
        if (!existing) return notFound(reply, c.resource);
        const at = scopeForWorkspace(ctx, existing.workspaceId);
        if (!at) return notFound(reply, 'workspace');
        const b = body(request);
        const patch: { name?: string; config?: Record<string, unknown> } = {};
        const name = str(b['name']);
        if (name) patch.name = name;
        if (b['config'] && typeof b['config'] === 'object') {
          const config = b['config'] as Record<string, unknown>;
          try {
            assertNoInlineSecret(config);
          } catch (e) {
            return reply
              .code(422)
              .send({ error: { type: 'inline_secret', message: (e as Error).message } });
          }
          patch.config = config;
        }
        if (patch.name === undefined && patch.config === undefined)
          return invalid(reply, 'name or config required');
        // The audit diff names WHAT changed (a name and/or config content hash before →
        // after) — it used to record only the name, so a config edit left a row that
        // said nothing about the change.
        const beforeHash = configHash(existing.config);
        const afterHash = patch.config ? configHash(patch.config) : beforeHash;
        if (
          patch.name !== undefined &&
          patch.name !== existing.name &&
          c.kind !== 'budget' &&
          nameTaken(ctx, c.kind, existing.workspaceId, patch.name)
        )
          return conflict(reply, `${c.resource} "${patch.name}" already exists in this workspace`);
        const r = await consoleWrite(ctx, admin, {
          perm: `${c.resource}:update` as Permission,
          at,
          action: `${c.kind}.update`,
          target: id,
          diff: {
            name: patch.name ?? existing.name,
            nameChanged: patch.name !== undefined && patch.name !== existing.name,
            configChanged: afterHash !== beforeHash,
            configHashBefore: beforeHash,
            configHashAfter: afterHash,
          },
          memory: () => ctx.collections[c.kind].update(id, patch),
          durable: async (b) =>
            (await b.updateEntityById(c.kind, id, patch)) ? { ...existing, ...patch } : undefined,
        });
        return r.ok ? reply.send({ entity: r.value }) : forbidden(reply);
      }),
    );
    app.delete(
      `/${c.path}/:id`,
      adminRoute(ctx, async (request, reply, admin) => {
        const id = paramId(request);
        const existing = ctx.collections[c.kind].get(id);
        if (!existing) return notFound(reply, c.resource);
        const at = scopeForWorkspace(ctx, existing.workspaceId);
        if (!at) return notFound(reply, 'workspace');
        const r = await consoleWrite(ctx, admin, {
          perm: `${c.resource}:delete` as Permission,
          at,
          action: `${c.kind}.delete`,
          target: id,
          diff: { id, name: existing.name },
          memory: () => ctx.collections[c.kind].delete(id),
          durable: (b) => b.deleteEntityById(c.kind, id),
        });
        return r.ok ? reply.send({ deleted: r.value }) : forbidden(reply);
      }),
    );
  }

  // --- provider + workspace deletion (create/read existed; close the lifecycle) ---
  app.delete(
    '/providers/:id',
    adminRoute(ctx, async (request, reply, admin) => {
      const id = paramId(request);
      const at = scopeForProvider(ctx, id);
      if (!at) return notFound(reply, 'provider');
      const r = await consoleWrite(ctx, admin, {
        perm: 'provider:delete',
        at,
        action: 'provider.delete',
        target: id,
        diff: { id },
        memory: () => ctx.providers.delete(id),
        durable: (b) => b.deleteProviderById(id),
      });
      return r.ok ? reply.send({ deleted: r.value }) : forbidden(reply);
    }),
  );
  app.delete(
    '/workspaces/:id',
    adminRoute(ctx, async (request, reply, admin) => {
      const id = paramId(request);
      const at = scopeForWorkspace(ctx, id);
      if (!at) return notFound(reply, 'workspace');
      const r = await auditedWrite(ctx, admin, {
        perm: 'workspace:delete',
        at,
        action: 'workspace.delete',
        target: id,
        diff: { id },
        mutate: () => ctx.workspaces.delete(id),
      });
      return r.ok ? reply.send({ deleted: r.value }) : forbidden(reply);
    }),
  );

  // --- governed prompt registry (versioned, hash-chained templates) ---
  const promptScope = async (
    id: string,
  ): Promise<{ at: ReturnType<typeof scopeForWorkspace>; wsId?: string }> => {
    const t = isUuid(id) ? await ctx.prompts.get(id) : undefined;
    if (!t) return { at: undefined };
    return { at: scopeForWorkspace(ctx, t.workspaceId), wsId: t.workspaceId };
  };

  app.post(
    '/prompts',
    adminRoute(ctx, async (request, reply, admin) => {
      const b = body(request);
      const workspaceId = str(b['workspaceId']);
      const name = str(b['name']);
      const promptBody = typeof b['body'] === 'string' ? b['body'] : undefined;
      const message = str(b['message']);
      if (!workspaceId || !name || promptBody === undefined)
        return invalid(reply, 'workspaceId, name and body required');
      const at = scopeForWorkspace(ctx, workspaceId);
      if (!at) return notFound(reply, 'workspace');
      if (!(await ctx.access.can(admin, 'prompt:create', at))) return forbidden(reply);
      let created;
      try {
        created = await ctx.prompts.create(workspaceId, name, {
          body: promptBody,
          createdBy: admin.subject,
          ...(message !== undefined ? { message } : {}),
        });
      } catch (e) {
        if (e instanceof PromptNameConflictError)
          return reply.code(409).send({ error: { type: 'conflict', message: e.message } });
        throw e;
      }
      const head = created.versions[created.versions.length - 1]!;
      await ctx.audit.append({
        orgId: at.orgId ?? null,
        actor: admin.subject,
        action: 'prompt.create',
        target: created.id,
        payload: { name, version: head.version, hash: head.hash, variables: head.variables },
      });
      return reply.code(201).send({ prompt: created });
    }),
  );

  app.post(
    '/prompts/:id/versions',
    adminRoute(ctx, async (request, reply, admin) => {
      const id = paramId(request);
      const { at } = await promptScope(id);
      if (!at) return notFound(reply, 'prompt');
      const b = body(request);
      const promptBody = typeof b['body'] === 'string' ? b['body'] : undefined;
      const message = str(b['message']);
      if (promptBody === undefined) return invalid(reply, 'body required');
      if (!(await ctx.access.can(admin, 'prompt:update', at))) return forbidden(reply);
      const v = await ctx.prompts.addVersion(id, {
        body: promptBody,
        createdBy: admin.subject,
        ...(message !== undefined ? { message } : {}),
      });
      if (!v) return notFound(reply, 'prompt');
      await ctx.audit.append({
        orgId: at.orgId ?? null,
        actor: admin.subject,
        action: 'prompt.version.create',
        target: id,
        payload: { version: v.version, hash: v.hash, prevHash: v.prevHash, variables: v.variables },
      });
      return reply.code(201).send({ version: v });
    }),
  );

  app.get(
    '/prompts',
    adminRoute(ctx, async (_req, reply, admin) => {
      const visible = visibleWorkspaceIds(ctx, admin);
      return reply.send({ prompts: await ctx.prompts.list([...visible]) });
    }),
  );

  app.get(
    '/prompts/:id',
    adminRoute(ctx, async (request, reply, admin) => {
      const id = uuidParam(request);
      const t = id ? await ctx.prompts.get(id) : undefined;
      if (!t || !id) return notFound(reply, 'prompt');
      const at = scopeForWorkspace(ctx, t.workspaceId) ?? {};
      if (!(await ctx.access.can(admin, 'prompt:read', at))) return forbidden(reply);
      return reply.send({ prompt: t });
    }),
  );

  app.get(
    '/prompts/:id/verify',
    adminRoute(ctx, async (request, reply, admin) => {
      const id = uuidParam(request);
      const t = id ? await ctx.prompts.get(id) : undefined;
      if (!t || !id) return notFound(reply, 'prompt');
      const at = scopeForWorkspace(ctx, t.workspaceId) ?? {};
      if (!(await ctx.access.can(admin, 'prompt:read', at))) return forbidden(reply);
      return reply.send(await ctx.prompts.verifyChain(id));
    }),
  );

  // Render a version (head by default) with caller-supplied variables. A read op
  // that takes a body, so POST — but gated on prompt:read, never a write.
  app.post(
    '/prompts/:id/render',
    adminRoute(ctx, async (request, reply, admin) => {
      const id = uuidParam(request);
      const t = id ? await ctx.prompts.get(id) : undefined;
      if (!t || !id) return notFound(reply, 'prompt');
      const at = scopeForWorkspace(ctx, t.workspaceId) ?? {};
      if (!(await ctx.access.can(admin, 'prompt:read', at))) return forbidden(reply);
      const b = body(request);
      const versionNum = typeof b['version'] === 'number' ? b['version'] : undefined;
      const vars =
        b['variables'] && typeof b['variables'] === 'object'
          ? (b['variables'] as Record<string, unknown>)
          : {};
      const v = versionNum ? await ctx.prompts.version(id, versionNum) : await ctx.prompts.head(id);
      if (!v) return notFound(reply, 'version');
      try {
        return reply.send({ version: v.version, rendered: renderPrompt(v.body, vars) });
      } catch (e) {
        if (e instanceof MissingVariablesError)
          return reply
            .code(422)
            .send({ error: { type: 'missing_variables', message: e.message, missing: e.missing } });
        throw e;
      }
    }),
  );

  app.delete(
    '/prompts/:id',
    adminRoute(ctx, async (request, reply, admin) => {
      const id = paramId(request);
      const { at } = await promptScope(id);
      if (!at) return notFound(reply, 'prompt');
      if (!(await ctx.access.can(admin, 'prompt:delete', at))) return forbidden(reply);
      const deleted = await ctx.prompts.delete(id);
      await ctx.audit.append({
        orgId: at.orgId ?? null,
        actor: admin.subject,
        action: 'prompt.delete',
        target: id,
        payload: { id },
      });
      return reply.send({ deleted });
    }),
  );

  // --- audit chain verification (platform admin) ---
  app.get(
    '/audit/verify',
    adminRoute(ctx, async (_req, reply, admin) => {
      if (!(await ctx.access.can(admin, 'audit:verify', {}))) return forbidden(reply);
      return reply.send(await ctx.verifyAudit());
    }),
  );

  // Auditor attestation export: an independently-signed statement over the audit
  // chain (verified status + row count + first/last hash + time range). 501 until a
  // signer is configured. With an asymmetric (KMS) audit signer the auditor verifies
  // OFFLINE with only the published public key (GET /.well-known/gulley-audit-key);
  // the HMAC key is the shared-secret fallback.
  app.get(
    '/audit/attestation',
    adminRoute(ctx, async (_req, reply, admin) => {
      if (!(await ctx.access.can(admin, 'audit:verify', {}))) return forbidden(reply);
      if (!ctx.auditRows)
        return reply.code(501).send({
          error: { type: 'not_configured', message: 'attestation signing not configured' },
        });
      const signed = await signCtxAttestation(ctx, await ctx.auditRows(), new Date().toISOString());
      if (!signed)
        return reply.code(501).send({
          error: { type: 'not_configured', message: 'attestation signing not configured' },
        });
      return reply.send(signed);
    }),
  );

  // Evidence bundle: ONE downloadable, independently-verifiable compliance artifact —
  // the signed attestation + the full ordered audit rows (for an independent re-walk) +
  // the audit-export public key (asymmetric) + a WORM mirror-status snapshot. An auditor
  // verifies it offline (verifyEvidenceBundle) with only the out-of-band public key.
  // 501 until a signer is configured.
  app.get(
    '/audit/evidence-bundle',
    adminRoute(ctx, async (_req, reply, admin) => {
      if (!(await ctx.access.can(admin, 'audit:verify', {}))) return forbidden(reply);
      if (!ctx.auditRows)
        return reply
          .code(501)
          .send({ error: { type: 'not_configured', message: 'audit rows not available' } });
      const rows = await ctx.auditRows();
      const generatedAt = new Date().toISOString();
      const attestation = await signCtxAttestation(ctx, rows, generatedAt);
      if (!attestation)
        return reply.code(501).send({
          error: { type: 'not_configured', message: 'attestation signing not configured' },
        });
      const publicKey = ctx.auditSigner
        ? { alg: ctx.auditSigner.algorithm, pem: await ctx.auditSigner.publicKeyPem() }
        : undefined;
      const wormResult = ctx.wormShipper ? await ctx.wormShipper.verify() : undefined;
      const worm = wormResult
        ? {
            verified: wormResult.ok,
            rows: wormResult.rows,
            lastSeq: wormResult.lastSeq,
            ...(wormResult.reason !== undefined ? { reason: wormResult.reason } : {}),
          }
        : undefined;
      const bundle = buildEvidenceBundle({
        rows,
        attestation,
        toolVersion: GULLEY_VERSION,
        generatedAt,
        ...(ctx.attestationSubject !== undefined ? { subject: ctx.attestationSubject } : {}),
        ...(publicKey ? { publicKey } : {}),
        ...(worm ? { worm } : {}),
      });
      return reply
        .header('content-disposition', 'attachment; filename="gulley-evidence-bundle.json"')
        .send(bundle);
    }),
  );

  // The audit-export public key — PUBLIC (no auth), so an auditor can fetch it
  // out-of-band and verify BOTH the attestation and the WORM batch signatures offline.
  // 404 until an asymmetric (KMS) audit signer is configured (HMAC has no public key).
  app.get('/.well-known/gulley-audit-key', async (_request, reply) => {
    if (!ctx.auditSigner)
      return reply
        .code(404)
        .send({ error: { type: 'not_found', message: 'no asymmetric audit signer' } });
    return reply.send({
      alg: ctx.auditSigner.algorithm,
      publicKey: await ctx.auditSigner.publicKeyPem(),
    });
  });

  // --- WORM-live: the retained S3 Object Lock (COMPLIANCE) system of record ---
  // The audit chain is continuously mirrored to immutable storage in signed,
  // contiguous batches, so the record survives a Postgres compromise and is provably
  // un-tampered. All three endpoints 501 until WORM is configured.
  const wormNotConfigured = (reply: FastifyReply): FastifyReply =>
    reply.code(501).send({ error: { type: 'not_configured', message: 'WORM not configured' } });

  // Shipper status: the last seq mirrored to WORM this process (0 until a ship runs;
  // GET /audit/worm/verify gives the authoritative count from the mirror itself).
  app.get(
    '/audit/worm/status',
    adminRoute(ctx, async (_req, reply, admin) => {
      if (!(await ctx.access.can(admin, 'audit:verify', {}))) return forbidden(reply);
      if (!ctx.wormShipper) return wormNotConfigured(reply);
      return reply.send({ enabled: true, lastSeq: ctx.wormShipper.lastSeq });
    }),
  );

  // Ship on demand (also runs on a background timer). Single-flight + idempotent, so
  // an overlapping manual/timer trigger is safe. A broken existing WORM record makes
  // this fail closed (409) rather than extend a compromised chain.
  app.post(
    '/audit/worm/ship',
    adminRoute(ctx, async (_req, reply, admin) => {
      if (!(await ctx.access.can(admin, 'audit:verify', {}))) return forbidden(reply);
      if (!ctx.wormShipper) return wormNotConfigured(reply);
      try {
        return reply.send(await ctx.wormShipper.ship());
      } catch (err) {
        _req.log.warn({ err }, 'WORM ship refused');
        return reply.code(409).send({
          error: {
            type: 'worm_integrity',
            message: 'WORM mirror integrity check failed; see GET /audit/worm/verify',
          },
        });
      }
    }),
  );

  // Independently verify the mirrored chain: every batch signature is authentic, its
  // hash recomputes, the rowHash links join across batches, and the seq is gapless.
  app.get(
    '/audit/worm/verify',
    adminRoute(ctx, async (_req, reply, admin) => {
      if (!(await ctx.access.can(admin, 'audit:verify', {}))) return forbidden(reply);
      if (!ctx.wormShipper) return wormNotConfigured(reply);
      return reply.send(await ctx.wormShipper.verify());
    }),
  );

  // --- Anchoring: publish signed chain-head checkpoints to an EXTERNAL append-only
  // sink, so even the operator (who controls Postgres AND WORM) cannot rewrite history
  // undetectably. 501 until an anchor sink + a signer are configured.
  const anchorNotConfigured = (reply: FastifyReply): FastifyReply =>
    reply
      .code(501)
      .send({ error: { type: 'not_configured', message: 'anchoring not configured' } });

  // Anchor the current head now (also runs on a background timer). Idempotent by head
  // seq, so an overlapping manual/timer publish is safe.
  app.post(
    '/audit/anchor',
    adminRoute(ctx, async (_req, reply, admin) => {
      if (!(await ctx.access.can(admin, 'audit:verify', {}))) return forbidden(reply);
      if (!ctx.anchor || !ctx.auditRows) return anchorNotConfigured(reply);
      const att = await signCtxAttestation(ctx, await ctx.auditRows(), new Date().toISOString());
      if (!att) return anchorNotConfigured(reply);
      return reply.send(await ctx.anchor.publish(att));
    }),
  );

  // The anchored checkpoints read back from the external sink.
  app.get(
    '/audit/anchors',
    adminRoute(ctx, async (_req, reply, admin) => {
      if (!(await ctx.access.can(admin, 'audit:verify', {}))) return forbidden(reply);
      if (!ctx.anchor) return anchorNotConfigured(reply);
      return reply.send({ anchors: await ctx.anchor.list() });
    }),
  );

  // Detect a rewrite: verify each anchored checkpoint's signature, then confirm every
  // anchored head hash still appears at its seq in the CURRENT chain. A conflict is
  // proof history was rewritten after it was anchored.
  app.get(
    '/audit/anchor/verify',
    adminRoute(ctx, async (_req, reply, admin) => {
      if (!(await ctx.access.can(admin, 'audit:verify', {}))) return forbidden(reply);
      if (!ctx.anchor || !ctx.auditRows) return anchorNotConfigured(reply);
      const anchored = await ctx.anchor.list();
      const pem = ctx.auditSigner ? await ctx.auditSigner.publicKeyPem() : undefined;
      // A tampered sink entry (bad signature) is not counted as rewrite evidence — but
      // it IS reported, so the auditor sees the sink can't be trusted either way.
      const signaturesValid = anchored.every((a) =>
        pem
          ? verifyAttestationWithPublicKey(a, pem)
          : ctx.attestationKey
            ? verifyAttestation(a, ctx.attestationKey)
            : false,
      );
      const rewrite = detectChainRewrite(anchored, await ctx.auditRows());
      return reply.send({ signaturesValid, ...rewrite });
    }),
  );

  // --- SIEM export: stream the audit trail to Splunk / Sentinel / a webhook ---
  const siemNotConfigured = (reply: FastifyReply): FastifyReply =>
    reply
      .code(501)
      .send({ error: { type: 'not_configured', message: 'SIEM export not configured' } });

  app.get(
    '/audit/siem/status',
    adminRoute(ctx, async (_req, reply, admin) => {
      if (!(await ctx.access.can(admin, 'audit:verify', {}))) return forbidden(reply);
      if (!ctx.siemExporter) return siemNotConfigured(reply);
      return reply.send({
        enabled: true,
        kind: ctx.siemExporter.kind,
        lastSeq: ctx.siemExporter.lastExportedSeq,
      });
    }),
  );

  // Export new audit events now (also runs on a background timer). Single-flight;
  // at-least-once (a failed batch retries from the last delivered seq).
  app.post(
    '/audit/siem/export',
    adminRoute(ctx, async (_req, reply, admin) => {
      if (!(await ctx.access.can(admin, 'audit:verify', {}))) return forbidden(reply);
      if (!ctx.siemExporter) return siemNotConfigured(reply);
      try {
        return reply.send(await ctx.siemExporter.export());
      } catch (err) {
        _req.log.warn({ err }, 'SIEM export failed');
        return reply
          .code(502)
          .send({ error: { type: 'siem_error', message: 'SIEM connector delivery failed' } });
      }
    }),
  );
}
