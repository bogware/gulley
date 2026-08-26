'use client';

import { CollectionPage } from '../../components/collection-page';

export default function BudgetsPage() {
  return (
    <CollectionPage
      kind="budgets"
      title="Budgets"
      subtitle="USD spend caps per workspace (micro-USD; omit periodSeconds for a lifetime cap)."
      placeholder={'{\n  "capMicroUsd": 100000000,\n  "periodSeconds": 2592000\n}'}
    />
  );
}
