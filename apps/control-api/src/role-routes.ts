import {
  ALL_PERMISSIONS,
  BUILTIN_ROLES,
  builtinRole,
  can,
  canAnywhere,
  effectivePermissionsAt,
  isPermission,
  isRole,
  isRoleId,
  type Permission,
} from '@gulley/rbac';
import { BuiltinRoleError } from '@gulley/storage';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { adminRoute, body, forbidden, notFound, strMax } from './admin';
import type { ControlContext } from './context';
import { roleDefinitionOf } from './roles';

function invalid(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(422).send({ error: { type: 'validation', message } });
}

function conflict(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(409).send({ error: { type: 'conflict', message } });
}

const MAX_NAME = 128;
const MAX_DESCRIPTION = 1_024;
const MAX_PERMISSIONS = 256;

/** Parse + validate a `permissions` field: an array of known permission names
 *  (de-duplicated, sorted). Returns a message on failure. */
function permissionsField(
  v: unknown,
): { ok: true; value: Permission[] } | { ok: false; message: string } {
  if (!Array.isArray(v)) return { ok: false, message: 'permissions must be an array' };
  if (v.length > MAX_PERMISSIONS)
    return { ok: false, message: `at most ${MAX_PERMISSIONS} permissions` };
  const out = new Set<Permission>();
  for (const p of v) {
    if (!isPermission(p)) {
      return {
        ok: false,
        message: `unknown permission ${JSON.stringify(p)}; see GET /roles for the catalogue`,
      };
    }
    out.add(p);
  }
  return { ok: true, value: [...out].sort() };
}

/**
 * Custom-role catalogue (P11). Roles are platform-wide objects, so the write
 * permissions are checked at the platform scope (`{}` — a platform-wide grant); any
 * admin with `role:read` at some scope may list them (the Access tab needs the
 * catalogue to grant a membership in its own org). Built-ins are read-only (409).
 * Every write is audited and invalidates the resolver snapshot.
 */
export function registerRoleRoutes(app: FastifyInstance, ctx: ControlContext): void {
  const resolver = ctx.roleResolver;

  app.get(
    '/roles',
    adminRoute(ctx, async (_request, reply, admin) => {
      if (!canAnywhere(admin, 'role:read', resolver)) return forbidden(reply);
      const rows = await ctx.roles.list();
      // Built-ins come from code (the engine resolves them from code too); the stored
      // rows contribute only the custom roles.
      const custom = rows.filter((r) => !r.builtin && !isRole(r.id)).map(roleDefinitionOf);
      return reply.send({
        roles: [...BUILTIN_ROLES, ...custom],
        permissions: ALL_PERMISSIONS,
      });
    }),
  );

  app.post(
    '/roles',
    adminRoute(ctx, async (request, reply, admin) => {
      await resolver.ensureFresh();
      if (!can(admin, 'role:create', {}, resolver)) return forbidden(reply);
      const b = body(request);
      const id = b['id'];
      if (!isRoleId(id)) {
        return invalid(
          reply,
          'id must be 1..64 lowercase letters, digits, ".", "_" or "-" (starting with a letter or digit)',
        );
      }
      const name = strMax(b['name'], MAX_NAME);
      if (!name) return invalid(reply, `name must be 1..${MAX_NAME} characters`);
      const description =
        b['description'] === undefined || b['description'] === null
          ? undefined
          : strMax(b['description'], MAX_DESCRIPTION);
      if (b['description'] && description === undefined)
        return invalid(reply, `description must be at most ${MAX_DESCRIPTION} characters`);
      const perms = permissionsField(b['permissions'] ?? []);
      if (!perms.ok) return invalid(reply, perms.message);
      if (builtinRole(id)) return conflict(reply, `role "${id}" is built-in`);
      // A role may not carry a permission its author does not hold: the grant check
      // would refuse it anyway, but refusing here keeps the catalogue honest.
      const held = effectivePermissionsAt(admin, {}, resolver);
      const beyond = perms.value.filter((p) => !held.has(p));
      if (beyond.length > 0) {
        return reply.code(403).send({
          error: {
            type: 'permission_error',
            message: `a role may not grant permissions you do not hold: ${beyond.join(', ')}`,
          },
        });
      }
      if (await ctx.roles.get(id)) return conflict(reply, `role "${id}" already exists`);
      let created;
      try {
        created = await ctx.roles.create(id, {
          name,
          description: description ?? null,
          permissions: perms.value,
        });
      } catch (e) {
        // A concurrent create of the same id surfaces as the unique violation.
        if ((e as { code?: string }).code === '23505')
          return conflict(reply, `role "${id}" already exists`);
        throw e;
      }
      resolver.invalidate();
      await ctx.audit.append({
        orgId: null,
        actor: admin.subject,
        action: 'role.create',
        target: id,
        payload: { name, permissions: perms.value, description: description ?? null },
      });
      return reply.code(201).send({ role: roleDefinitionOf(created) });
    }),
  );

  app.put(
    '/roles/:id',
    adminRoute(ctx, async (request, reply, admin) => {
      await resolver.ensureFresh();
      if (!can(admin, 'role:update', {}, resolver)) return forbidden(reply);
      const id = (request.params as { id: string }).id;
      if (!isRoleId(id)) return notFound(reply, 'role');
      if (builtinRole(id)) return conflict(reply, `role "${id}" is built-in and immutable`);
      const b = body(request);
      const patch: { name?: string; description?: string | null; permissions?: Permission[] } = {};
      if (b['name'] !== undefined) {
        const name = strMax(b['name'], MAX_NAME);
        if (!name) return invalid(reply, `name must be 1..${MAX_NAME} characters`);
        patch.name = name;
      }
      if (b['description'] !== undefined) {
        if (b['description'] === null || b['description'] === '') patch.description = null;
        else {
          const d = strMax(b['description'], MAX_DESCRIPTION);
          if (!d)
            return invalid(reply, `description must be at most ${MAX_DESCRIPTION} characters`);
          patch.description = d;
        }
      }
      if (b['permissions'] !== undefined) {
        const perms = permissionsField(b['permissions']);
        if (!perms.ok) return invalid(reply, perms.message);
        const held = effectivePermissionsAt(admin, {}, resolver);
        const beyond = perms.value.filter((p) => !held.has(p));
        if (beyond.length > 0) {
          return reply.code(403).send({
            error: {
              type: 'permission_error',
              message: `a role may not grant permissions you do not hold: ${beyond.join(', ')}`,
            },
          });
        }
        patch.permissions = perms.value;
      }
      if (Object.keys(patch).length === 0) return invalid(reply, 'nothing to update');
      let updated;
      try {
        updated = await ctx.roles.update(id, patch);
      } catch (e) {
        if (e instanceof BuiltinRoleError) return conflict(reply, e.message);
        throw e;
      }
      if (!updated) return notFound(reply, 'role');
      resolver.invalidate();
      await ctx.audit.append({
        orgId: null,
        actor: admin.subject,
        action: 'role.update',
        target: id,
        payload: patch,
      });
      return reply.send({ role: roleDefinitionOf(updated) });
    }),
  );

  app.delete(
    '/roles/:id',
    adminRoute(ctx, async (request, reply, admin) => {
      await resolver.ensureFresh();
      if (!can(admin, 'role:delete', {}, resolver)) return forbidden(reply);
      const id = (request.params as { id: string }).id;
      if (!isRoleId(id)) return notFound(reply, 'role');
      if (builtinRole(id)) return conflict(reply, `role "${id}" is built-in and immutable`);
      let deleted: boolean;
      try {
        deleted = await ctx.roles.delete(id);
      } catch (e) {
        if (e instanceof BuiltinRoleError) return conflict(reply, e.message);
        throw e;
      }
      if (!deleted) return notFound(reply, 'role');
      resolver.invalidate();
      // Memberships that still name the id become inert (an unknown role grants
      // nothing); they stay listed so an admin can see and revoke them.
      await ctx.audit.append({
        orgId: null,
        actor: admin.subject,
        action: 'role.delete',
        target: id,
        payload: {},
      });
      return reply.send({ deleted: true });
    }),
  );
}
