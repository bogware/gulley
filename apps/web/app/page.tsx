const SECTIONS: Array<{ title: string; desc: string; api: string; status: 'ready' | 'planned' }> = [
  {
    title: 'Dashboard',
    desc: 'Spend + usage summary and recent requests at a glance.',
    api: 'GET /admin/analytics/usage · GET /admin/logs',
    status: 'ready',
  },
  {
    title: 'Request logs',
    desc: 'Browse, filter, and paginate every proxied request.',
    api: 'GET /admin/logs · GET /admin/logs/:id',
    status: 'ready',
  },
  {
    title: 'Analytics',
    desc: 'Time-bucketed spend and token usage, split by provider or model.',
    api: 'GET /admin/analytics/usage',
    status: 'ready',
  },
  {
    title: 'Virtual keys',
    desc: 'Mint, view, and revoke API keys scoped to a workspace.',
    api: 'POST /keys · GET /keys/:id',
    status: 'ready',
  },
  {
    title: 'Providers',
    desc: 'Configure upstream providers and their secret-ref credentials.',
    api: 'GET/POST /providers',
    status: 'ready',
  },
  {
    title: 'Orgs & workspaces',
    desc: 'The tenancy tree that scopes keys, budgets, and policies.',
    api: 'GET/POST /orgs · /workspaces',
    status: 'ready',
  },
  {
    title: 'Routes & policies',
    desc: 'Routing strategies, model aliases, and CEL authz/transform rules.',
    api: 'GET/POST /routes · /model-aliases',
    status: 'planned',
  },
  {
    title: 'Budgets & rate limits',
    desc: 'USD caps and RPM/TPM limits per workspace.',
    api: 'GET/POST /budgets · /rate-limits',
    status: 'ready',
  },
  {
    title: 'Guardrails',
    desc: 'Native PII/secret detection + webhook DLP policy.',
    api: 'GET/POST /guardrails',
    status: 'ready',
  },
  {
    title: 'Audit',
    desc: 'Verify the tamper-evident hash-chained audit log.',
    api: 'GET /audit/verify',
    status: 'ready',
  },
];

export default function Home() {
  return (
    <main className="mx-auto max-w-5xl px-6 py-16">
      <header className="mb-10">
        <h1 className="text-3xl font-semibold tracking-tight">Gulley</h1>
        <p className="mt-1 text-neutral-500">Enterprise LLM gateway — control plane console.</p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {SECTIONS.map((s) => (
          <div
            key={s.title}
            className="rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900"
          >
            <div className="flex items-center justify-between">
              <h2 className="font-medium">{s.title}</h2>
              <span
                className={
                  s.status === 'ready'
                    ? 'rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
                    : 'rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400'
                }
              >
                {s.status === 'ready' ? 'API ready' : 'planned'}
              </span>
            </div>
            <p className="mt-2 text-sm text-neutral-500">{s.desc}</p>
            <code className="mt-3 block truncate font-mono text-xs text-neutral-400">{s.api}</code>
          </div>
        ))}
      </div>

      <footer className="mt-10 text-sm text-neutral-400">
        Data layer scaffolded in <code className="font-mono">lib/api.ts</code>. See{' '}
        <code className="font-mono">docs/ADMIN_UI.md</code> for the build plan.
      </footer>
    </main>
  );
}
