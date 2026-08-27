import type { ConfigDocument } from '@gulley/config';
import type { SmartRoutingPolicy } from '@gulley/routing';
import { z } from 'zod';

/**
 * Zod validation for the `smartRoutingPolicies` config collection (M15 Phase B).
 * The document layer only checks each entity is `{ name, config }`; this is the
 * consumer-boundary schema for the inner `config`. A parse failure THROWS, so a
 * malformed policy rejects the reconcile and the gateway keeps its prior snapshot
 * (the same contract as `buildRoutesFromDocument`). Secrets are never inlined:
 * `assertNoInlineSecret` already rejects a raw key anywhere in the document, and
 * a classifier reuses a provider's resolved credential via `providerRef`.
 */
const classifierRuleSchema = z
  .object({
    category: z.string().min(1),
    anyOf: z.array(z.string()).optional(),
    regex: z.string().optional(),
    maxChars: z.number().int().positive().optional(),
  })
  .strict();

const classifierSpecSchema = z
  .object({
    mode: z.enum(['embedding-nearest-label', 'llm-router', 'rules-then-llm']),
    labels: z.array(z.string()).optional(),
    exemplars: z.record(z.string(), z.array(z.string())).optional(),
    rules: z.array(classifierRuleSchema).optional(),
    model: z.string().optional(),
    providerRef: z.string().optional(),
    timeoutMs: z.number().int().positive().optional(),
    meterClassifier: z.boolean().optional(),
  })
  .strict();

const selectorSchema = z
  .object({
    user: z.string().optional(),
    group: z.string().optional(),
    org: z.string().optional(),
    workspace: z.string().optional(),
    route: z.string().optional(),
  })
  .strict();

const policyConfigSchema = z
  .object({
    objective: z.enum(['cost-tier', 'domain-skill', 'safety-risk', 'operator-taxonomy']),
    classifier: classifierSpecSchema,
    categoryRoutes: z.record(z.string(), z.string()),
    defaultCategory: z.string().optional(),
    selector: selectorSchema.default({}),
    priority: z.number().optional(),
  })
  .strict();

export type SmartRoutingPolicyConfig = z.infer<typeof policyConfigSchema>;

/** Parse + validate a single policy `config` object. Throws on an invalid shape. */
export function parseSmartRoutingPolicyConfig(config: unknown): SmartRoutingPolicyConfig {
  return policyConfigSchema.parse(config);
}

/**
 * Extract every workspace's smart-routing policies from a config document as
 * validated, typed `SmartRoutingPolicy` values (route references, not live
 * strategies). Throws (rejecting the reconcile) if any policy config is invalid.
 *
 * Policies are flattened into one list matched by their `selector`. Selectors key
 * off runtime IDs (`scope.workspaceId`/`orgId` are UUIDs) while the document nests
 * under org/workspace NAMES, so the owning workspace is NOT auto-injected — a
 * policy with no `selector.workspace` is GLOBAL. That is correct for v1
 * (single-tenant per deployment); a MULTI-TENANT deployment MUST pin
 * `selector.workspace` (the workspace id) on each policy, or it applies to every
 * tenant. See docs/M15_SMART_ROUTING.md.
 */
export function parseSmartRoutingPolicies(doc: ConfigDocument): SmartRoutingPolicy<string>[] {
  const out: SmartRoutingPolicy<string>[] = [];
  for (const org of doc.orgs) {
    for (const ws of org.workspaces) {
      for (const ent of ws.smartRoutingPolicies ?? []) {
        const cfg = parseSmartRoutingPolicyConfig(ent.config);
        out.push({ name: ent.name, ...cfg });
      }
    }
  }
  return out;
}
