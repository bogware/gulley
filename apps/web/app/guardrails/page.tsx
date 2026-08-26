'use client';

import { CollectionPage } from '../../components/collection-page';

export default function GuardrailsPage() {
  return (
    <CollectionPage
      kind="guardrails"
      title="Guardrails"
      subtitle="Per-workspace guardrail policy (native detection is on by default)."
      placeholder={'{\n  "action": "audit"\n}'}
    />
  );
}
