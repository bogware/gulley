'use client';

import { CollectionPage } from '../../components/collection-page';

export default function RateLimitsPage() {
  return (
    <CollectionPage
      kind="rate-limits"
      title="Rate limits"
      subtitle="RPM/TPM fixed-window limits per workspace."
      placeholder={'{\n  "limit": 60,\n  "windowSeconds": 60,\n  "unit": "requests"\n}'}
    />
  );
}
