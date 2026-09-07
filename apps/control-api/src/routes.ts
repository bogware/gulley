import { type AdminSessionClaims, signAdminSession } from '@gulley/auth';
import { assertNoInlineSecret, attestAuditChain } from '@gulley/pipeline';
import { MissingVariablesError, PromptNameConflictError, renderPrompt } from '@gulley/prompts';
import { GULLEY_VERSION, secretRef } from '@gulley/core';
import { assertEgressAllowed } from '@gulley/egress';
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
  forbidden,
  notFound,
  scopeForProvider,
  scopeForWorkspace,
  str,
  visibleWorkspaceIds,
} from './admin';
import { type ClientAgent, generateClientConfig } from './client-config';
import type { ControlContext } from './context';
import type { CollectionKind } from './domain';
import type { FastifyInstance, FastifyReply } from 'fastify';

function invalid(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(422).send({ error: { type: 'validation', message } });
}

function paramId(request: { params: unknown }): string {
  return (request.params as { id: string }).id;
}

export function registerAdminRoutes(app: FastifyInstance, ctx: ControlContext): void {
  // --- admin session minting (owner→session exchange; no amplification) ---
  app.post(
    '/admin/sessions',
    adminRoute(ctx, async (request, reply, admin) => {
      const b = body(request);
      const subject = str(b['subject']) ?? `sess-${randomUUID()}`;
      const name = str(b['name']) ?? subject;
      const maxTtl = ctx.resolverDeps.maxSessionTtlMs / 1000;
      const ttlSeconds = Math.min(Number(b['ttlSeconds']) || 900, maxTtl);
      const rawMemberships = Array.isArray(b['memberships']) ? b['memberships'] : [];

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
      };
      const token = signAdminSession(secret, claims);
      await ctx.audit.append({
        orgId: null,
        actor: admin.subject,
        action: 'admin.session.mint',
        target: subject,
        payload: { jti, memberships },
      });
      return reply.code(201).send({ token, expiresAt: new Date(claims.exp * 1000).toISOString() });
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
        mutate: () => ctx.orgs.delete(id),
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
          return reply.code(422).send({ error: { type: 'egress', message: (e as Error).message } });
        }
      }
      const r = await auditedWrite(ctx, admin, {
        perm: 'provider:create',
        at,
        action: 'provider.create',
        target: workspaceId,
        diff: { kind, baseUrl: baseUrl ?? null },
        mutate: () =>
          ctx.providers.create({ workspaceId, kind, baseUrl: baseUrl ?? null, enabled: true }),
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
      const r = await auditedWrite(ctx, admin, {
        perm: 'provider:update',
        at,
        action: 'provider.credential.set',
        target: id,
        diff: { credential: ref },
        mutate: () => ctx.credentials.set(id, ref),
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
      const subject = str(b['subject']);
      const userId = str(b['userId']);
      const role = b['role'];
      const orgId = str(b['orgId']);
      const workspaceId = str(b['workspaceId']) ?? null;
      if (!isRole(role) || !orgId) return invalid(reply, 'role, orgId required');
      const at = { orgId, workspaceId };
      if (!can(admin, 'membership:create', at)) return forbidden(reply);
      if (role === 'owner' && !can(admin, 'membership:grant_owner', at)) return forbidden(reply);
      if (roleRank[role] > maxRankAt(admin, at)) return forbidden(reply);

      if (ctx.durableMemberships && ctx.adminUsers) {
        const uid = subject
          ? (await ctx.adminUsers.upsertBySubject(subject, str(b['displayName']) ?? subject)).id
          : userId;
        if (!uid) return invalid(reply, 'subject (or userId) required');
        const created = await ctx.durableMemberships.create(uid, role, orgId, workspaceId);
        await ctx.audit.append({
          orgId,
          actor: admin.subject,
          action: 'membership.create',
          target: subject ?? uid,
          payload: { role, orgId, workspaceId, subject },
        });
        return reply.code(201).send({ membership: created });
      }

      if (!userId) return invalid(reply, 'userId required');
      const created = ctx.memberships.create({ userId, role, orgId, workspaceId });
      await ctx.audit.append({
        orgId,
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
      const id = paramId(request);
      const ok = await ctx.durableMemberships.delete(id);
      if (!ok) return notFound(reply, 'membership');
      await ctx.audit.append({
        actor: admin.subject,
        action: 'membership.delete',
        target: id,
        payload: {},
      });
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
      const view = await ctx.keys.get(paramId(request));
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
      const agent: ClientAgent =
        str((request.query as Record<string, unknown>)?.['agent']) === 'codex'
          ? 'codex'
          : 'claude-code';
      const allow = new Set<string>();
      for (const e of ctx.collections['policy'].all()) {
        if (e.workspaceId !== workspaceId) continue;
        const a = e.config['allow'];
        if (Array.isArray(a)) for (const m of a) if (typeof m === 'string') allow.add(m);
      }
      const config = generateClientConfig({
        agent,
        gatewayUrl: ctx.gatewayPublicUrl,
        allowedModels: [...allow],
      });
      return reply.send({ config });
    }),
  );
  // Revoke (disable) a key — effective on the gateway's next lookup.
  app.post(
    '/keys/:id/disable',
    adminRoute(ctx, async (request, reply, admin) => {
      const view = await ctx.keys.get(paramId(request));
      if (!view) return notFound(reply, 'key');
      const at = scopeForWorkspace(ctx, view.workspaceId) ?? {};
      if (!(await ctx.access.can(admin, 'key:create', at))) return forbidden(reply);
      const updated = await ctx.keys.disable(view.id);
      await ctx.audit.append({
        orgId: at.orgId ?? '',
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
      const view = await ctx.keys.get(paramId(request));
      if (!view) return notFound(reply, 'key');
      const at = scopeForWorkspace(ctx, view.workspaceId) ?? {};
      if (!(await ctx.access.can(admin, 'key:create', at))) return forbidden(reply);
      const rotated = await ctx.keys.rotate(view.id);
      await ctx.audit.append({
        orgId: at.orgId ?? '',
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
        const r = await auditedWrite(ctx, admin, {
          perm: `${c.resource}:create` as Permission,
          at,
          action: `${c.kind}.create`,
          target: workspaceId,
          diff: { name },
          mutate: () => ctx.collections[c.kind].create(workspaceId, name, config),
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
        const r = await auditedWrite(ctx, admin, {
          perm: `${c.resource}:update` as Permission,
          at,
          action: `${c.kind}.update`,
          target: id,
          diff: { name: patch.name ?? existing.name },
          mutate: () => ctx.collections[c.kind].update(id, patch),
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
        const r = await auditedWrite(ctx, admin, {
          perm: `${c.resource}:delete` as Permission,
          at,
          action: `${c.kind}.delete`,
          target: id,
          diff: { id, name: existing.name },
          mutate: () => ctx.collections[c.kind].delete(id),
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
      const r = await auditedWrite(ctx, admin, {
        perm: 'provider:delete',
        at,
        action: 'provider.delete',
        target: id,
        diff: { id },
        mutate: () => ctx.providers.delete(id),
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
  const promptScope = (id: string): { at: ReturnType<typeof scopeForWorkspace>; wsId?: string } => {
    const t = ctx.prompts.get(id);
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
        created = ctx.prompts.create(workspaceId, name, {
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
      const { at } = promptScope(id);
      if (!at) return notFound(reply, 'prompt');
      const b = body(request);
      const promptBody = typeof b['body'] === 'string' ? b['body'] : undefined;
      const message = str(b['message']);
      if (promptBody === undefined) return invalid(reply, 'body required');
      if (!(await ctx.access.can(admin, 'prompt:update', at))) return forbidden(reply);
      const v = ctx.prompts.addVersion(id, {
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
      return reply.send({ prompts: ctx.prompts.list([...visible]) });
    }),
  );

  app.get(
    '/prompts/:id',
    adminRoute(ctx, async (request, reply, admin) => {
      const id = paramId(request);
      const t = ctx.prompts.get(id);
      if (!t) return notFound(reply, 'prompt');
      const at = scopeForWorkspace(ctx, t.workspaceId) ?? {};
      if (!(await ctx.access.can(admin, 'prompt:read', at))) return forbidden(reply);
      return reply.send({ prompt: t });
    }),
  );

  app.get(
    '/prompts/:id/verify',
    adminRoute(ctx, async (request, reply, admin) => {
      const id = paramId(request);
      const t = ctx.prompts.get(id);
      if (!t) return notFound(reply, 'prompt');
      const at = scopeForWorkspace(ctx, t.workspaceId) ?? {};
      if (!(await ctx.access.can(admin, 'prompt:read', at))) return forbidden(reply);
      return reply.send(ctx.prompts.verifyChain(id));
    }),
  );

  // Render a version (head by default) with caller-supplied variables. A read op
  // that takes a body, so POST — but gated on prompt:read, never a write.
  app.post(
    '/prompts/:id/render',
    adminRoute(ctx, async (request, reply, admin) => {
      const id = paramId(request);
      const t = ctx.prompts.get(id);
      if (!t) return notFound(reply, 'prompt');
      const at = scopeForWorkspace(ctx, t.workspaceId) ?? {};
      if (!(await ctx.access.can(admin, 'prompt:read', at))) return forbidden(reply);
      const b = body(request);
      const versionNum = typeof b['version'] === 'number' ? b['version'] : undefined;
      const vars =
        b['variables'] && typeof b['variables'] === 'object'
          ? (b['variables'] as Record<string, unknown>)
          : {};
      const v = versionNum ? ctx.prompts.version(id, versionNum) : ctx.prompts.head(id);
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
      const { at } = promptScope(id);
      if (!at) return notFound(reply, 'prompt');
      if (!(await ctx.access.can(admin, 'prompt:delete', at))) return forbidden(reply);
      const deleted = ctx.prompts.delete(id);
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
  // chain (verified status + row count + first/last hash + time range). 501 until an
  // attestation key is configured. The auditor holds the same key to verify it.
  app.get(
    '/audit/attestation',
    adminRoute(ctx, async (_req, reply, admin) => {
      if (!(await ctx.access.can(admin, 'audit:verify', {}))) return forbidden(reply);
      if (!ctx.attestationKey || !ctx.auditRows)
        return reply
          .code(501)
          .send({ error: { type: 'not_configured', message: 'attestation key not set' } });
      const rows = await ctx.auditRows();
      const signed = attestAuditChain(rows, {
        key: ctx.attestationKey,
        toolVersion: GULLEY_VERSION,
        generatedAt: new Date().toISOString(),
        ...(ctx.attestationSubject !== undefined ? { subject: ctx.attestationSubject } : {}),
      });
      return reply.send(signed);
    }),
  );
}
