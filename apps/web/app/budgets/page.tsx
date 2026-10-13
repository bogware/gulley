'use client';

import { CollectionPage } from '../../components/collection-page';

export default function BudgetsPage() {
  return (
    <CollectionPage
      kind="budgets"
      title="Budgets"
      subtitle="Hard USD caps (micro-USD) for the workspace, or — with a scope — for one key, user, team or project, or every one of that kind (omit scope.id for the default). windows: daily / weekly / monthly (UTC) stack; the legacy capMicroUsd + periodSeconds shape still works."
      placeholder={
        '{\n  "scope": { "kind": "key" },\n  "windows": [\n    { "capMicroUsd": 10000000, "period": "daily" },\n    { "capMicroUsd": 100000000, "period": "monthly" }\n  ]\n}'
      }
    />
  );
}
