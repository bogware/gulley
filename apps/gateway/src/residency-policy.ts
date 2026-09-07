/**
 * Data-residency + Zero-Data-Retention policy — the deployment's geo/retention
 * governance over WHICH upstream may serve a request.
 *
 * Single-tenant v1: one deployment serves one team/org, so the policy applies
 * gateway-wide from env (RESIDENCY_ALLOWED_REGIONS + RESIDENCY_REQUIRE_ZDR), mirroring
 * how the model allow/deny policy and per-workspace guardrails apply globally in v1.
 *
 * Unlike the model policy (a pure function of the request-model STRING, enforced at
 * authz), residency is a property of the CHOSEN UPSTREAM (its declared region + ZDR
 * posture), so enforcement lives in candidate selection: `selectCandidates` drops any
 * target that is not `residencyCompliant`, and an empty result fails CLOSED. A target
 * with an unknown region can never satisfy an active allowlist, and a non-ZDR target
 * can never satisfy `requireZdr` — missing data is treated as non-compliant.
 *
 * Off by default: with no env set the policy is undefined and selection is unchanged.
 */
export interface ResidencyPolicy {
  /** Allowed upstream regions. Empty = no region restriction. */
  allowedRegions: string[];
  /** Require every served upstream to be ZDR-enrolled. */
  requireZdr: boolean;
}

/** A policy is meaningful only if it constrains region or retention. */
export function isEmptyResidencyPolicy(policy: ResidencyPolicy | undefined): boolean {
  return !policy || (policy.allowedRegions.length === 0 && !policy.requireZdr);
}

/** Build the residency policy from env (the env-config path). Returns undefined when
 *  nothing is constrained, so the pipeline can cheaply skip enforcement. */
export function residencyPolicyFromEnv(
  allowedRegions: string,
  requireZdr: boolean,
): ResidencyPolicy | undefined {
  const regions = allowedRegions
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return regions.length === 0 && !requireZdr ? undefined : { allowedRegions: regions, requireZdr };
}

/** The allowed-region set to pass to `selectCandidates`, or undefined when the policy
 *  places no region restriction (ZDR-only or empty). */
export function residencyAllowedRegions(
  policy: ResidencyPolicy | undefined,
): ReadonlySet<string> | undefined {
  return policy && policy.allowedRegions.length > 0 ? new Set(policy.allowedRegions) : undefined;
}
