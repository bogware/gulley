import type { BudgetStore } from '@gulley/budget';
import { computeCost, emptyUsage, type RateResolver, toMicroUsd } from '@gulley/cost';
import type { AuditSink, Ledger } from '@gulley/pipeline';
import type { ClassifierUsage } from '@gulley/routing';

/** The ctx ports the classifier sub-meter needs (a narrow view of GatewayContext,
 *  so this module never imports the hot-path file). */
export interface ClassifierMeterDeps {
  budgets: BudgetStore;
  ledger: Ledger;
  audit: AuditSink;
  rateResolver?: RateResolver;
}

export interface ClassifierMeterPrincipal {
  id: string;
  orgId: string;
  workspaceId: string;
}

/**
 * Meter one classifier sub-call's spend against the tenant budget, INDEPENDENTLY
 * of the served request's reserve/commit — a derived request id
 * `${requestId}#classify` keeps it off the main reservation — with its own
 * `proxy.classify` ledger + audit line. Metered only from the raw provider usage
 * the completer reported. Best-effort and fail-open: it never registers a second
 * teardown, never hijacks, and a metering error never affects the served request.
 */
export async function meterClassifierSpend(
  deps: ClassifierMeterDeps,
  principal: ClassifierMeterPrincipal,
  requestId: string,
  usage: ClassifierUsage,
): Promise<void> {
  // Cost the sub-call inside the fail-open guard too: an (unexpected) throw from a
  // custom rateResolver must never propagate into the served request.
  let cost;
  let micro: number;
  try {
    cost = computeCost(
      usage.provider,
      usage.model,
      {
        ...emptyUsage(),
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        seen: true,
      },
      deps.rateResolver,
    );
    micro = toMicroUsd(cost.totalUsd);
  } catch {
    return; // costing failed → nothing to meter, and never fail the served request
  }
  const subId = `${requestId}#classify`;
  const ws = principal.workspaceId;

  // Decrement the tenant budget by the actual classifier spend (reserve = commit).
  // Commit ONLY when a reservation was actually taken — a workspace with no budget
  // (reserve → null) has no counter to meter against, matching the served-request
  // path. Best-effort: over-cap or a counter outage must not fail the request.
  try {
    const decision = await deps.budgets.reserve(ws, subId, micro);
    if (decision && decision.allowed) {
      await deps.budgets.commit(ws, subId, micro);
    }
  } catch {
    /* budget metering is best-effort */
  }

  const createdAt = new Date();
  try {
    await deps.ledger.record({
      requestId: subId,
      principalId: principal.id,
      orgId: principal.orgId,
      workspaceId: ws,
      provider: usage.provider,
      model: usage.model,
      cost,
      costMicroUsd: micro,
      status: 'ok',
      createdAt,
    });
  } catch {
    /* best-effort */
  }
  try {
    await deps.audit.append({
      orgId: principal.orgId,
      actor: principal.id,
      action: 'proxy.classify',
      target: usage.provider,
      payload: {
        provider: usage.provider,
        model: usage.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costMicroUsd: micro,
      },
    });
  } catch {
    /* best-effort */
  }
}
