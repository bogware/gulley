import type { AdminUserRow } from '@gulley/storage';
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
 * with. Group→role provisioning is a documented follow-up; role assignment today is
 * via POST /memberships or the OIDC group map.
 */
const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
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
}
