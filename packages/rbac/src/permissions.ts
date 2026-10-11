import type { BuiltinRole } from './principal';

export type Resource =
  | 'org'
  | 'workspace'
  | 'project'
  | 'provider'
  | 'route'
  | 'policy'
  | 'key'
  | 'budget'
  | 'ratelimit'
  | 'guardrail'
  | 'prompt'
  | 'membership'
  | 'role'
  | 'config'
  | 'audit';

export type Action = 'read' | 'create' | 'update' | 'delete';

/** A permission is `resource:action`, plus a few named capabilities that don't
 *  fit the CRUD grid (owner-only grants, config apply, audit verification, the
 *  high-privilege de-mask reveal that exposes raw secret/PII values, and the key
 *  lifecycle verbs that are deliberately distinct from minting). */
export type Permission =
  | `${Resource}:${Action}`
  | 'membership:grant_owner'
  | 'config:apply'
  | 'audit:verify'
  | 'guardrail:reveal'
  | 'key:disable'
  | 'key:rotate';

const READABLE: Resource[] = [
  'org',
  'workspace',
  'project',
  'provider',
  'route',
  'policy',
  'key',
  'budget',
  'ratelimit',
  'guardrail',
  'prompt',
  'membership',
  'role',
  'config',
  'audit',
];

// Resources editors may create/update/delete. `org` (create/delete), `role`,
// `membership` and `budget` are handled explicitly per role below.
const EDITABLE: Resource[] = [
  'workspace',
  'project',
  'provider',
  'route',
  'policy',
  'key',
  'ratelimit',
  'guardrail',
  'prompt',
];

function reads(): Permission[] {
  return READABLE.map((r) => `${r}:read` as Permission);
}

function edits(): Permission[] {
  return EDITABLE.flatMap((r) => [`${r}:create`, `${r}:update`, `${r}:delete`] as Permission[]);
}

const BUDGET_WRITE: Permission[] = ['budget:create', 'budget:update', 'budget:delete'];
const MEMBERSHIP_WRITE: Permission[] = ['membership:create', 'membership:delete'];
const ROLE_WRITE: Permission[] = ['role:create', 'role:update', 'role:delete'];
// Disabling / rotating a key is a lifecycle action on an EXISTING key; it is not
// minting (`key:create`). A custom role may hold one without the other.
const KEY_LIFECYCLE: Permission[] = ['key:disable', 'key:rotate'];

const viewer = new Set<Permission>(reads());
const billing = new Set<Permission>([...reads(), ...BUDGET_WRITE]);
const editor = new Set<Permission>([...reads(), ...edits(), ...BUDGET_WRITE, ...KEY_LIFECYCLE]);
const admin = new Set<Permission>([...editor, ...MEMBERSHIP_WRITE, ...ROLE_WRITE, 'audit:verify']);
const owner = new Set<Permission>([
  ...admin,
  'org:create',
  'org:delete',
  'membership:grant_owner',
  'config:apply',
  // De-masking exposes raw secret/PII values — owner-only, above admin.
  'guardrail:reveal',
]);

/** Permission set granted by each built-in role. Higher roles strictly include lower. */
export const PERMISSIONS_BY_ROLE: Readonly<Record<BuiltinRole, ReadonlySet<Permission>>> = {
  viewer,
  billing,
  editor,
  admin,
  owner,
};

/**
 * The permission universe a custom role may draw from: every permission some
 * built-in role holds (= the owner set, since owner ⊇ every other built-in). A
 * permission outside this list is unknown to the control plane and is rejected on
 * role create/update. Sorted so the console can render a stable grid.
 */
export const ALL_PERMISSIONS: readonly Permission[] = [...owner].sort();

const ALL_SET: ReadonlySet<string> = new Set(ALL_PERMISSIONS);

export function isPermission(v: unknown): v is Permission {
  return typeof v === 'string' && ALL_SET.has(v);
}

/** The `resource` half of a permission (`key:rotate` → `key`). */
export function permissionResource(p: Permission): Resource {
  return p.slice(0, p.indexOf(':')) as Resource;
}
