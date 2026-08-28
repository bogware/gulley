import type { Role } from './principal';

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
  | 'config'
  | 'audit';

export type Action = 'read' | 'create' | 'update' | 'delete';

/** A permission is `resource:action`, plus a few named capabilities that don't
 *  fit the CRUD grid (owner-only grants, config apply, audit verification). */
export type Permission =
  `${Resource}:${Action}` | 'membership:grant_owner' | 'config:apply' | 'audit:verify';

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
  'config',
  'audit',
];

// Resources editors may create/update/delete. `org` (create/delete) and
// `membership`/`budget` are handled explicitly per role below.
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

const viewer = new Set<Permission>(reads());
const billing = new Set<Permission>([...reads(), ...BUDGET_WRITE]);
const editor = new Set<Permission>([...reads(), ...edits(), ...BUDGET_WRITE]);
const admin = new Set<Permission>([...editor, ...MEMBERSHIP_WRITE, 'audit:verify']);
const owner = new Set<Permission>([
  ...admin,
  'org:create',
  'org:delete',
  'membership:grant_owner',
  'config:apply',
]);

/** Permission set granted by each role. Higher roles strictly include lower. */
export const PERMISSIONS_BY_ROLE: Readonly<Record<Role, ReadonlySet<Permission>>> = {
  viewer,
  billing,
  editor,
  admin,
  owner,
};
