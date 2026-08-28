/**
 * The published OpenAPI 3.1 description of the Gulley control-plane admin API.
 * This module is the single source of truth; `scripts/emit-openapi.ts` serializes
 * it to `docs/openapi/control-api.json` for distribution and codegen. Keep it in
 * sync with `apps/control-api/src/routes.ts` + `config-routes.ts`.
 */

export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

export interface OpenApiOperation {
  summary: string;
  operationId: string;
  tags: string[];
  security?: Array<Record<string, string[]>>;
  parameters?: Array<{
    name: string;
    in: 'path' | 'query';
    required?: boolean;
    schema: { type: string };
  }>;
  requestBody?: {
    required?: boolean;
    content: { 'application/json': { schema: { type: string } } };
  };
  responses: Record<string, { description: string }>;
}

export type OpenApiPathItem = Partial<Record<'get' | 'post' | 'put' | 'delete', OpenApiOperation>>;

export interface OpenApiDocument {
  openapi: '3.1.0';
  info: { title: string; version: string; description: string };
  servers: Array<{ url: string; description?: string }>;
  tags: Array<{ name: string; description: string }>;
  components: {
    securitySchemes: Record<string, { type: string; scheme?: string; description?: string }>;
  };
  security: Array<Record<string, string[]>>;
  paths: Record<string, OpenApiPathItem>;
}

const BEARER = [{ bearerAuth: [] as string[] }];

function op(
  operationId: string,
  summary: string,
  tags: string[],
  opts: {
    params?: OpenApiOperation['parameters'];
    body?: boolean;
    responses?: Record<string, string>;
    public?: boolean;
  } = {},
): OpenApiOperation {
  const responses: OpenApiOperation['responses'] = {};
  const r = opts.responses ?? { '200': 'OK' };
  for (const [code, description] of Object.entries(r)) responses[code] = { description };
  if (!opts.public) {
    responses['401'] ??= { description: 'missing or invalid admin credentials' };
  }
  return {
    summary,
    operationId,
    tags,
    ...(opts.public ? { security: [] } : { security: BEARER }),
    ...(opts.params ? { parameters: opts.params } : {}),
    ...(opts.body
      ? {
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        }
      : {}),
    responses,
  };
}

const idParam = [{ name: 'id', in: 'path' as const, required: true, schema: { type: 'string' } }];

// The six workspace-scoped config collections share one CRUD shape.
const COLLECTIONS = ['routes', 'policies', 'budgets', 'rate-limits', 'guardrails', 'model-aliases'];

function collectionPaths(): Record<string, OpenApiPathItem> {
  const out: Record<string, OpenApiPathItem> = {};
  for (const c of COLLECTIONS) {
    const tag = 'config';
    out[`/${c}`] = {
      get: op(`list_${c}`, `List ${c}`, [tag]),
      post: op(`create_${c}`, `Create a ${c} entity`, [tag], {
        body: true,
        responses: { '201': 'created', '422': 'validation error' },
      }),
    };
    out[`/${c}/{id}`] = {
      put: op(`update_${c}`, `Update a ${c} entity`, [tag], {
        params: idParam,
        body: true,
        responses: { '200': 'updated', '404': 'not found', '422': 'validation error' },
      }),
      delete: op(`delete_${c}`, `Delete a ${c} entity`, [tag], {
        params: idParam,
        responses: { '200': 'deleted', '404': 'not found' },
      }),
    };
  }
  return out;
}

export const controlApiOpenApi: OpenApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'Gulley Control API',
    version: '1.0.0',
    description:
      'Admin control-plane for the Gulley LLM gateway: orgs/workspaces/providers, ' +
      'virtual keys, workspace-scoped config collections, the governed prompt registry, ' +
      'GitOps config apply, and audit-chain verification. Every write is hash-chain audited.',
  },
  servers: [{ url: 'http://localhost:8081', description: 'local dev' }],
  tags: [
    { name: 'system', description: 'health/readiness' },
    { name: 'tenancy', description: 'orgs, workspaces, memberships' },
    { name: 'providers', description: 'upstream providers + secret-ref credentials' },
    { name: 'keys', description: 'virtual key lifecycle' },
    { name: 'config', description: 'workspace-scoped config collections' },
    { name: 'prompts', description: 'governed, versioned, hash-chained prompt registry' },
    { name: 'gitops', description: 'declarative config apply' },
    { name: 'audit', description: 'tamper-evident audit chain' },
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        description: 'Admin session token (gses_) or bootstrap token (gadm_).',
      },
    },
  },
  security: BEARER,
  paths: {
    '/health': { get: op('health', 'Liveness probe', ['system'], { public: true }) },
    '/orgs': {
      get: op('list_orgs', 'List orgs', ['tenancy']),
      post: op('create_org', 'Create an org', ['tenancy'], {
        body: true,
        responses: { '201': 'created' },
      }),
    },
    '/orgs/{id}': {
      delete: op('delete_org', 'Delete an org', ['tenancy'], {
        params: idParam,
        responses: { '200': 'deleted' },
      }),
    },
    '/workspaces': {
      get: op('list_workspaces', 'List workspaces', ['tenancy']),
      post: op('create_workspace', 'Create a workspace', ['tenancy'], {
        body: true,
        responses: { '201': 'created', '404': 'org not found' },
      }),
    },
    '/workspaces/{id}': {
      delete: op('delete_workspace', 'Delete a workspace', ['tenancy'], {
        params: idParam,
        responses: { '200': 'deleted', '404': 'not found' },
      }),
    },
    '/memberships': {
      post: op('create_membership', 'Grant a membership', ['tenancy'], {
        body: true,
        responses: { '201': 'created', '403': 'no amplification' },
      }),
    },
    '/providers': {
      get: op('list_providers', 'List providers', ['providers']),
      post: op('create_provider', 'Register a provider', ['providers'], {
        body: true,
        responses: { '201': 'created', '404': 'workspace not found', '422': 'egress blocked' },
      }),
    },
    '/providers/{id}': {
      delete: op('delete_provider', 'Delete a provider', ['providers'], {
        params: idParam,
        responses: { '200': 'deleted', '404': 'not found' },
      }),
    },
    '/providers/{id}/credential': {
      post: op(
        'set_provider_credential',
        'Set a provider credential (secret ARN only)',
        ['providers'],
        { params: idParam, body: true, responses: { '201': 'created', '422': 'invalid ref' } },
      ),
    },
    '/keys': {
      get: op('list_keys', 'List a workspace’s keys', ['keys']),
      post: op('mint_key', 'Mint a virtual key (token returned once)', ['keys'], {
        body: true,
        responses: { '201': 'created', '404': 'workspace not found' },
      }),
    },
    '/keys/{id}': {
      get: op('get_key', 'Get a key (secret-free view)', ['keys'], {
        params: idParam,
        responses: { '200': 'OK', '404': 'not found' },
      }),
    },
    '/keys/{id}/disable': {
      post: op('disable_key', 'Revoke (disable) a key', ['keys'], {
        params: idParam,
        responses: { '200': 'disabled', '404': 'not found' },
      }),
    },
    '/keys/{id}/rotate': {
      post: op('rotate_key', 'Rotate a key’s secret (same id)', ['keys'], {
        params: idParam,
        responses: { '200': 'rotated', '404': 'not found' },
      }),
    },
    ...collectionPaths(),
    '/prompts': {
      get: op('list_prompts', 'List prompt summaries', ['prompts']),
      post: op('create_prompt', 'Create a prompt template (v1)', ['prompts'], {
        body: true,
        responses: { '201': 'created', '409': 'name conflict', '422': 'validation error' },
      }),
    },
    '/prompts/{id}': {
      get: op('get_prompt', 'Get a prompt template with its version history', ['prompts'], {
        params: idParam,
        responses: { '200': 'OK', '404': 'not found' },
      }),
      delete: op('delete_prompt', 'Delete a prompt template', ['prompts'], {
        params: idParam,
        responses: { '200': 'deleted', '404': 'not found' },
      }),
    },
    '/prompts/{id}/versions': {
      post: op('add_prompt_version', 'Append a new version', ['prompts'], {
        params: idParam,
        body: true,
        responses: { '201': 'created', '404': 'not found' },
      }),
    },
    '/prompts/{id}/render': {
      post: op('render_prompt', 'Render a version with variables', ['prompts'], {
        params: idParam,
        body: true,
        responses: { '200': 'OK', '404': 'not found', '422': 'missing variables' },
      }),
    },
    '/prompts/{id}/verify': {
      get: op('verify_prompt_chain', 'Verify a prompt’s hash chain', ['prompts'], {
        params: idParam,
        responses: { '200': 'OK', '404': 'not found' },
      }),
    },
    '/config/apply': {
      post: op(
        'apply_config',
        'Apply a declarative config document (optimistic concurrency)',
        ['gitops'],
        { body: true, responses: { '200': 'applied', '409': 'stale baseVersion' } },
      ),
    },
    '/audit/verify': {
      get: op('verify_audit', 'Verify the audit hash chain', ['audit']),
    },
  },
};
