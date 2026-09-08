import type { AdminUserRow, ScimGroupRow } from '@gulley/storage';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { adminRoute, body, str } from './admin';
import type { ControlContext } from './context';

/**
 * SCIM 2.0 provisioning (Users) — so an IdP (Okta / Entra) manages the admin-user
 * lifecycle. A provisioned user maps to an `admin_user` row (durable RBAC, 7a);
 * DEPROVISIONING (DELETE, or PATCH active=false) deletes the row, which cascades to
 * its membership grants — so an IdP offboard immediately revokes gateway access
 * (the membership loader stops returning the grants on the user's next request).
 *
 * Requires a database (identities are inherently durable) and platform-owner authz
 * (membership:create at the platform scope), the credential an IdP is configured
 * with. Groups (/scim/v2/Groups) map a provisioned group's displayName to a role via
 * SCIM_GROUP_ROLE_MAP and grant it to each member; role assignment is also available
 * via POST /memberships or the OIDC/App-Role login claim.
 */
const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';
const SCIM_CT = 'application/scim+json';

function scimError(
  reply: FastifyReply,
  status: number,
  detail: string,
  scimType?: string,
): FastifyReply {
  return reply
    .code(status)
    .header('content-type', SCIM_CT)
    .send({
      schemas: [ERROR_SCHEMA],
      detail,
      status: String(status),
      ...(scimType ? { scimType } : {}),
    });
}

function toScimUser(u: AdminUserRow, active = true): Record<string, unknown> {
  return {
    schemas: [USER_SCHEMA],
    id: u.id,
    userName: u.subject,
    displayName: u.displayName,
    active,
    ...(u.email ? { emails: [{ value: u.email, primary: true }] } : {}),
    meta: { resourceType: 'User', location: `/scim/v2/Users/${u.id}` },
  };
}

function firstEmail(b: Record<string, unknown>): string | undefined {
  const emails = b['emails'];
  if (Array.isArray(emails)) {
    for (const e of emails) {
      const v = (e as Record<string, unknown>)?.['value'];
      if (typeof v === 'string' && v.length > 0) return v;
    }
  }
  return undefined;
}

/** Parse a trivial SCIM filter `userName eq "value"` (the shape IdPs use to look up
 *  a user before create). Returns the value, or undefined for anything else. */
function parseUserNameEq(filter: string | undefined): string | undefined {
  if (!filter) return undefined;
  const m = /^\s*userName\s+eq\s+"(.*)"\s*$/i.exec(filter);
  return m ? m[1] : undefined;
}

function parseDisplayNameEq(filter: string | undefined): string | undefined {
  if (!filter) return undefined;
  const m = /^\s*displayName\s+eq\s+"(.*)"\s*$/i.exec(filter);
  return m ? m[1] : undefined;
}

function toScimGroup(g: ScimGroupRow): Record<string, unknown> {
  return {
    schemas: [GROUP_SCHEMA],
    id: g.id,
    displayName: g.displayName,
    ...(g.externalId ? { externalId: g.externalId } : {}),
    members: g.members.map((id) => ({ value: id })),
    meta: { resourceType: 'Group', location: `/scim/v2/Groups/${g.id}` },
  };
}

/** SCIM member references from a `members` value array → admin_user ids. */
function memberValues(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((m) => (m as Record<string, unknown>)?.['value'])
    .filter((x): x is string => typeof x === 'string' && x.length > 0);
}

/** Parse a SCIM Group PatchOp into member adds/removes/replace (the shapes Entra/Okta
 *  send for group membership sync). */
function parseGroupPatch(b: Record<string, unknown>): {
  adds: string[];
  removes: string[];
  replace?: string[];
} {
  const ops = b['Operations'] ?? b['operations'];
  const adds: string[] = [];
  const removes: string[] = [];
  let replace: string[] | undefined;
  if (!Array.isArray(ops)) return { adds, removes };
  for (const raw of ops) {
    const op = raw as Record<string, unknown>;
    const kind = String(op['op']).toLowerCase();
    const path = typeof op['path'] === 'string' ? (op['path'] as string) : undefined;
    if (kind === 'add' && (!path || path === 'members')) adds.push(...memberValues(op['value']));
    else if (kind === 'replace' && (!path || path === 'members'))
      replace = memberValues(op['value']);
    else if (kind === 'remove') {
      // `members[value eq "id"]` or a value array.
      const m = path && /members\[value eq "(.+?)"\]/i.exec(path);
      if (m) removes.push(m[1]!);
      else removes.push(...memberValues(op['value']));
    }
  }
  return { adds, removes, ...(replace !== undefined ? { replace } : {}) };
}

/** True when a SCIM PatchOp sets `active` to false (the deprovision signal). */
function patchDeactivates(b: Record<string, unknown>): boolean {
  const ops = b['Operations'] ?? b['operations'];
  if (!Array.isArray(ops)) return false;
  for (const raw of ops) {
    const op = raw as Record<string, unknown>;
    if (String(op['op']).toLowerCase() !== 'replace') continue;
    const path = typeof op['path'] === 'string' ? (op['path'] as string) : undefined;
    const value = op['value'];
    if (path === 'active' && value === false) return true;
    if (
      !path &&
      value &&
      typeof value === 'object' &&
      (value as Record<string, unknown>)['active'] === false
    ) {
      return true;
    }
  }
  return false;
}

export function registerScimRoutes(app: FastifyInstance, ctx: ControlContext): void {
  const users = ctx.adminUsers;
  // One guard for every SCIM route: durable store + platform-owner authz.
  const guard = async (
    _request: FastifyRequest,
    reply: FastifyReply,
    admin: Parameters<Parameters<typeof adminRoute>[1]>[2],
  ): Promise<boolean> => {
    if (!users) {
      scimError(reply, 501, 'SCIM provisioning requires a database');
      return false;
    }
    if (!(await ctx.access.can(admin, 'membership:create', {}))) {
      scimError(reply, 403, 'not authorized to provision', 'forbidden');
      return false;
    }
    return true;
  };

  app.post(
    '/scim/v2/Users',
    adminRoute(ctx, async (request, reply, admin) => {
      if (!users || !(await guard(request, reply, admin))) return reply;
      const b = body(request);
      const userName = str(b['userName']);
      if (!userName) return scimError(reply, 400, 'userName is required', 'invalidValue');
      const displayName = str(b['displayName']) ?? userName;
      const row = await users.upsertBySubject(userName, displayName, firstEmail(b) ?? null);
      await ctx.audit.append({
        actor: admin.subject,
        action: 'scim.user.provision',
        target: row.id,
        payload: { userName },
      });
      return reply.code(201).header('content-type', SCIM_CT).send(toScimUser(row));
    }),
  );

  app.get(
    '/scim/v2/Users/:id',
    adminRoute(ctx, async (request, reply, admin) => {
      if (!users || !(await guard(request, reply, admin))) return reply;
      const id = (request.params as { id: string }).id;
      const row = await users.get(id);
      if (!row) return scimError(reply, 404, 'user not found');
      return reply.header('content-type', SCIM_CT).send(toScimUser(row));
    }),
  );

  app.get(
    '/scim/v2/Users',
    adminRoute(ctx, async (request, reply, admin) => {
      if (!users || !(await guard(request, reply, admin))) return reply;
      const filterName = parseUserNameEq((request.query as Record<string, string>)?.['filter']);
      const all = await users.list();
      const matched = filterName ? all.filter((u) => u.subject === filterName) : all;
      return reply.header('content-type', SCIM_CT).send({
        schemas: [LIST_SCHEMA],
        totalResults: matched.length,
        startIndex: 1,
        itemsPerPage: matched.length,
        Resources: matched.map((u) => toScimUser(u)),
      });
    }),
  );

  app.patch(
    '/scim/v2/Users/:id',
    adminRoute(ctx, async (request, reply, admin) => {
      if (!users || !(await guard(request, reply, admin))) return reply;
      const id = (request.params as { id: string }).id;
      const row = await users.get(id);
      if (!row) return scimError(reply, 404, 'user not found');
      // The only PatchOp we act on is deactivation — an IdP deprovision. It DELETES
      // the admin_user, cascading its grants (immediate deauthz). Other patches are
      // accepted as no-ops so a provisioner's sync doesn't error.
      if (patchDeactivates(body(request))) {
        await users.delete(id);
        await ctx.audit.append({
          actor: admin.subject,
          action: 'scim.user.deprovision',
          target: id,
          payload: { userName: row.subject, via: 'patch-active-false' },
        });
        return reply.header('content-type', SCIM_CT).send(toScimUser(row, false));
      }
      return reply.header('content-type', SCIM_CT).send(toScimUser(row));
    }),
  );

  app.delete(
    '/scim/v2/Users/:id',
    adminRoute(ctx, async (request, reply, admin) => {
      if (!users || !(await guard(request, reply, admin))) return reply;
      const id = (request.params as { id: string }).id;
      const row = await users.get(id);
      if (!row) return scimError(reply, 404, 'user not found');
      await users.delete(id);
      await ctx.audit.append({
        actor: admin.subject,
        action: 'scim.user.deprovision',
        target: id,
        payload: { userName: row.subject, via: 'delete' },
      });
      return reply.code(204).send();
    }),
  );

  // --- SCIM Groups: an IdP-provisioned group grants its mapped role to each member ---

  const groups = ctx.scimGroups;
  const groupGuard = async (
    reply: FastifyReply,
    admin: Parameters<Parameters<typeof adminRoute>[1]>[2],
  ): Promise<boolean> => {
    if (!groups) {
      scimError(reply, 501, 'SCIM Groups requires a database');
      return false;
    }
    if (!(await ctx.access.can(admin, 'membership:create', {}))) {
      scimError(reply, 403, 'not authorized to provision', 'forbidden');
      return false;
    }
    return true;
  };

  app.post(
    '/scim/v2/Groups',
    adminRoute(ctx, async (request, reply, admin) => {
      if (!groups || !(await groupGuard(reply, admin))) return reply;
      const b = body(request);
      const displayName = str(b['displayName']);
      if (!displayName) return scimError(reply, 400, 'displayName is required', 'invalidValue');
      const g = await groups.create(displayName, str(b['externalId']) ?? null);
      for (const userId of memberValues(b['members'])) {
        await groups.addMember(g.id, userId, displayName);
      }
      await ctx.audit.append({
        actor: admin.subject,
        action: 'scim.group.provision',
        target: g.id,
        payload: { displayName, members: memberValues(b['members']).length },
      });
      const full = (await groups.get(g.id)) ?? g;
      return reply.code(201).header('content-type', SCIM_CT).send(toScimGroup(full));
    }),
  );

  app.get(
    '/scim/v2/Groups/:id',
    adminRoute(ctx, async (request, reply, admin) => {
      if (!groups || !(await groupGuard(reply, admin))) return reply;
      const g = await groups.get((request.params as { id: string }).id);
      if (!g) return scimError(reply, 404, 'group not found');
      return reply.header('content-type', SCIM_CT).send(toScimGroup(g));
    }),
  );

  app.get(
    '/scim/v2/Groups',
    adminRoute(ctx, async (request, reply, admin) => {
      if (!groups || !(await groupGuard(reply, admin))) return reply;
      const filterName = parseDisplayNameEq((request.query as Record<string, string>)?.['filter']);
      const all = await groups.list();
      const matched = filterName ? all.filter((g) => g.displayName === filterName) : all;
      return reply.header('content-type', SCIM_CT).send({
        schemas: [LIST_SCHEMA],
        totalResults: matched.length,
        startIndex: 1,
        itemsPerPage: matched.length,
        Resources: matched.map((g) => toScimGroup(g)),
      });
    }),
  );

  app.patch(
    '/scim/v2/Groups/:id',
    adminRoute(ctx, async (request, reply, admin) => {
      if (!groups || !(await groupGuard(reply, admin))) return reply;
      const id = (request.params as { id: string }).id;
      const g = await groups.get(id);
      if (!g) return scimError(reply, 404, 'group not found');
      const patch = parseGroupPatch(body(request));
      // `replace` sets the exact member set: remove those not in the new list, add new.
      if (patch.replace) {
        const next = new Set(patch.replace);
        for (const cur of g.members) if (!next.has(cur)) await groups.removeMember(id, cur);
        for (const uid of patch.replace) await groups.addMember(id, uid, g.displayName);
      }
      for (const uid of patch.adds) await groups.addMember(id, uid, g.displayName);
      for (const uid of patch.removes) await groups.removeMember(id, uid);
      await ctx.audit.append({
        actor: admin.subject,
        action: 'scim.group.update',
        target: id,
        payload: {
          added: patch.adds.length + (patch.replace?.length ?? 0),
          removed: patch.removes.length,
        },
      });
      return reply.header('content-type', SCIM_CT).send(toScimGroup((await groups.get(id)) ?? g));
    }),
  );

  app.delete(
    '/scim/v2/Groups/:id',
    adminRoute(ctx, async (request, reply, admin) => {
      if (!groups || !(await groupGuard(reply, admin))) return reply;
      const id = (request.params as { id: string }).id;
      if (!(await groups.delete(id))) return scimError(reply, 404, 'group not found');
      await ctx.audit.append({
        actor: admin.subject,
        action: 'scim.group.deprovision',
        target: id,
        payload: {},
      });
      return reply.code(204).send();
    }),
  );
}
