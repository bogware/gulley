'use client';

import Link from 'next/link';
import { useState } from 'react';
import {
  Button,
  Cell,
  CodeBlock,
  Dot,
  EmptyState,
  ErrorNote,
  Field,
  GridRow,
  InlineResult,
  Input,
  PageHeader,
  Panel,
  PanelHeader,
  SegmentedControl,
  Select,
  Spinner,
  StatusChip,
  Tabs,
} from '../../components/ui';
import { isNotConfigured } from '../../lib/api';
import { useAdmin } from '../../lib/admin-context';
import { formatTime } from '../../lib/format';
import { useAdminQuery } from '../../lib/hooks';
import type {
  AdminSessionInfo,
  ClientAgent,
  ClientAuthMode,
  DeviceCodeView,
  GeneratedClientConfig,
  Membership,
  OAuthClient,
  OAuthGrant,
} from '../../lib/types';

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
type Tab = 'people' | 'access' | 'oauth' | 'onboarding';

export default function IdentityPage() {
  const [tab, setTab] = useState<Tab>('people');
  return (
    <div>
      <PageHeader
        title="Identity"
        subtitle="Enterprise SSO / OAuth users going through the router — sessions, RBAC grants, the OAuth broker, and turnkey onboarding for Claude Code / Codex."
      />
      <div className="mb-4">
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'people', label: 'Users & sessions' },
            { value: 'access', label: 'Access (RBAC)' },
            { value: 'oauth', label: 'OAuth broker' },
            { value: 'onboarding', label: 'Onboarding' },
          ]}
        />
      </div>
      {tab === 'people' ? <PeopleTab /> : null}
      {tab === 'access' ? <AccessTab /> : null}
      {tab === 'oauth' ? <OAuthTab /> : null}
      {tab === 'onboarding' ? <OnboardingTab /> : null}
    </div>
  );
}

function PeopleTab() {
  const { api } = useAdmin();
  const users = useAdminQuery((a) => a.adminUsers(), []);
  const sessions = useAdminQuery((a) => a.sessions(), []);
  const [error, setError] = useState<string | undefined>(undefined);

  return (
    <div className="flex flex-col gap-4">
      {error ? <ErrorNote error={error} /> : null}
      <Panel className="overflow-hidden">
        <PanelHeader
          title="Provisioned users"
          meta={users.data?.durable ? `${users.data.users.length}` : 'in-memory (SCIM needs a DB)'}
        />
        {users.loading ? (
          <Spinner />
        ) : (users.data?.users.length ?? 0) === 0 ? (
          <EmptyState message="No provisioned admin users (SCIM/OIDC populate this in DB mode)." />
        ) : (
          <div>
            <GridRow cols="minmax(0,1fr) minmax(0,1fr) minmax(0,1fr)" header>
              <Cell>Subject</Cell>
              <Cell>Name</Cell>
              <Cell>Email</Cell>
            </GridRow>
            {users.data?.users.map((u) => (
              <GridRow key={u.id} cols="minmax(0,1fr) minmax(0,1fr) minmax(0,1fr)">
                <Cell mono tone="ink">
                  {u.subject}
                </Cell>
                <Cell tone="body">{u.displayName ?? '—'}</Cell>
                <Cell mono tone="secondary">
                  {u.email ?? '—'}
                </Cell>
              </GridRow>
            ))}
          </div>
        )}
      </Panel>

      <Panel className="overflow-hidden">
        <PanelHeader
          title="Admin sessions"
          meta={sessions.data?.enumerable ? `${sessions.data.sessions.length}` : 'not enumerable'}
          right={
            <Button variant="ghost" onClick={() => sessions.refetch()}>
              Refresh
            </Button>
          }
        />
        {sessions.loading ? (
          <Spinner />
        ) : (sessions.data?.sessions.length ?? 0) === 0 ? (
          <EmptyState message="No recorded sessions." />
        ) : (
          <div>
            <GridRow cols="minmax(0,1fr) 90px 130px 90px 80px" header>
              <Cell>Subject</Cell>
              <Cell>Source</Cell>
              <Cell>Expires</Cell>
              <Cell>State</Cell>
              <Cell align="right"> </Cell>
            </GridRow>
            {sessions.data?.sessions.map((s: AdminSessionInfo) => (
              <GridRow key={s.jti} cols="minmax(0,1fr) 90px 130px 90px 80px">
                <Cell mono tone="ink">
                  {s.subject}
                </Cell>
                <Cell>
                  <StatusChip tone="blue">{s.source}</StatusChip>
                </Cell>
                <Cell mono tone="secondary">
                  {formatTime(s.expiresAt)}
                </Cell>
                <Cell>
                  <StatusChip tone={s.revoked ? 'red' : 'green'}>
                    {s.revoked ? 'revoked' : 'active'}
                  </StatusChip>
                </Cell>
                <div className="flex justify-end">
                  {!s.revoked ? (
                    <Button
                      variant="ghost"
                      onClick={async () => {
                        if (!api) return;
                        try {
                          await api.revokeSession(s.jti);
                          sessions.refetch();
                        } catch (e) {
                          setError(msg(e));
                        }
                      }}
                    >
                      Revoke
                    </Button>
                  ) : null}
                </div>
              </GridRow>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}

function AccessTab() {
  const { api } = useAdmin();
  const memberships = useAdminQuery((a) => a.memberships(), []);
  const orgs = useAdminQuery((a) => a.orgs(), []);
  const [form, setForm] = useState({ subject: '', role: 'viewer', orgId: '' });
  const [error, setError] = useState<string | undefined>(undefined);

  const list = memberships.data?.memberships ?? [];

  return (
    <div className="flex flex-col gap-4">
      {error ? <ErrorNote error={error} /> : null}
      <Panel>
        <PanelHeader title="Grant a role" />
        <div className="grid grid-cols-1 gap-2.5 p-3.5 md:grid-cols-4">
          <Field label="Subject">
            <Input
              value={form.subject}
              onChange={(e) => setForm({ ...form, subject: e.target.value })}
              placeholder="user@acme"
            />
          </Field>
          <Field label="Role">
            <Select
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value })}
              className="w-full"
            >
              {['viewer', 'billing', 'editor', 'admin', 'owner'].map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Org">
            <Select
              value={form.orgId}
              onChange={(e) => setForm({ ...form, orgId: e.target.value })}
              className="w-full"
            >
              <option value="">org…</option>
              {orgs.data?.orgs.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex items-end">
            <Button
              variant="primary"
              disabled={!form.subject.trim() || !form.orgId}
              onClick={async () => {
                if (!api) return;
                try {
                  await api.createMembership({
                    subject: form.subject.trim(),
                    role: form.role,
                    orgId: form.orgId,
                  });
                  setForm({ ...form, subject: '' });
                  memberships.refetch();
                } catch (e) {
                  setError(msg(e));
                }
              }}
            >
              Grant
            </Button>
          </div>
        </div>
      </Panel>

      <Panel className="overflow-hidden">
        <PanelHeader title="Role grants" meta={`${list.length}`} />
        {memberships.loading ? (
          <Spinner />
        ) : memberships.error && isNotConfigured(memberships.error) ? (
          <EmptyState message="Durable memberships require a database." />
        ) : list.length === 0 ? (
          <EmptyState message="No grants." />
        ) : (
          <div>
            <GridRow cols="minmax(0,1fr) 90px minmax(0,1fr) 80px" header>
              <Cell>Subject</Cell>
              <Cell>Role</Cell>
              <Cell>Scope</Cell>
              <Cell align="right"> </Cell>
            </GridRow>
            {list.map((m: Membership, i) => (
              <GridRow key={m.id ?? i} cols="minmax(0,1fr) 90px minmax(0,1fr) 80px">
                <Cell mono tone="ink">
                  {m.subject ?? '—'}
                </Cell>
                <Cell>
                  <StatusChip tone="blue">{m.role}</StatusChip>
                </Cell>
                <Cell mono tone="secondary">
                  {m.orgId}
                  {m.workspaceId ? ` / ${m.workspaceId}` : ''}
                </Cell>
                <div className="flex justify-end">
                  {m.id ? (
                    <Button
                      variant="ghost"
                      onClick={async () => {
                        if (!api) return;
                        try {
                          await api.deleteMembership(m.id!);
                          memberships.refetch();
                        } catch (e) {
                          setError(msg(e));
                        }
                      }}
                    >
                      Revoke
                    </Button>
                  ) : null}
                </div>
              </GridRow>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}

function OAuthTab() {
  const { api } = useAdmin();
  const clients = useAdminQuery((a) => a.oauthClients(), []);
  const grants = useAdminQuery((a) => a.oauthGrants(), []);
  const devices = useAdminQuery((a) => a.oauthDeviceCodes(), []);
  const reuse = useAdminQuery((a) => a.refreshReuse(), []);
  const workspaces = useAdminQuery((a) => a.workspaces(), []);
  const [error, setError] = useState<string | undefined>(undefined);
  const [draft, setDraft] = useState({
    clientId: 'claude-code',
    name: 'Claude Code',
    workspaceId: '',
    device: true,
    authCode: false,
    redirects: '/callback',
  });
  const [saving, setSaving] = useState(false);

  if (clients.error && isNotConfigured(clients.error)) {
    return (
      <Panel>
        <PanelHeader title="OAuth broker not enabled (needs a database)" />
        <div className="p-4 text-[11.5px] leading-[1.7] text-body">
          The durable OAuth views need DATABASE_URL. Enable the broker with{' '}
          <span className="font-mono text-ink">OAUTH_BROKER_ENABLED=true</span> so Claude Code /
          Codex can authenticate via device + auth-code/PKCE and their grants appear here.
        </div>
      </Panel>
    );
  }

  const alerts = reuse.data?.alerts ?? [];

  return (
    <div className="flex flex-col gap-4">
      {error ? <ErrorNote error={error} /> : null}
      {alerts.length > 0 ? (
        <InlineResult tone="err">
          {alerts.length} refresh-token reuse (theft) alert{alerts.length === 1 ? '' : 's'} — the
          affected token families were auto-revoked.
        </InlineResult>
      ) : null}

      <Panel>
        <PanelHeader
          title="Device consent"
          meta="RFC 8628"
          right={
            <Link href="/oauth/device" className="text-[11.5px] text-ink underline">
              Open the consent page
            </Link>
          }
        />
        <div className="p-3.5 text-[11.5px] leading-[1.7] text-body">
          A developer runs <span className="font-mono text-ink">gulley login</span>; the agent shows
          a code and this console&apos;s <span className="font-mono text-ink">/oauth/device</span>{' '}
          page. Approving binds a short-lived token family to the approver&apos;s identity — Claude
          Code and Codex then fetch tokens through{' '}
          <span className="font-mono text-ink">gulley token</span>.
          {(devices.data?.deviceCodes.filter((d: DeviceCodeView) => d.status === 'pending')
            .length ?? 0) > 0 ? (
            <div className="mt-2">
              <StatusChip tone="blue">
                {devices.data?.deviceCodes.filter((d) => d.status === 'pending').length} pending
                authorization(s)
              </StatusChip>
            </div>
          ) : null}
        </div>
      </Panel>

      <Panel>
        <PanelHeader title="Register a client" meta="which agent may ask for tokens" />
        <form
          className="grid grid-cols-1 gap-3 p-3.5 md:grid-cols-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!api || !draft.workspaceId) return;
            const ws = workspaces.data?.workspaces.find((w) => w.id === draft.workspaceId);
            if (!ws) return;
            setSaving(true);
            setError(undefined);
            try {
              await api.saveOAuthClient({
                clientId: draft.clientId.trim(),
                name: draft.name.trim(),
                orgId: ws.orgId,
                workspaceId: ws.id,
                grantTypes: [
                  ...(draft.device ? ['device_code'] : []),
                  ...(draft.authCode ? ['authorization_code'] : []),
                  'refresh_token',
                ],
                redirectAllowlist: draft.redirects
                  .split(',')
                  .map((r) => r.trim())
                  .filter(Boolean),
                enabled: true,
              });
              clients.refetch();
            } catch (err) {
              setError(msg(err));
            } finally {
              setSaving(false);
            }
          }}
        >
          <Field label="Client id">
            <Input
              value={draft.clientId}
              onChange={(e) => setDraft({ ...draft, clientId: e.target.value })}
              placeholder="claude-code"
            />
          </Field>
          <Field label="Display name">
            <Input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="Claude Code"
            />
          </Field>
          <Field label="Workspace (tenancy the tokens are scoped to)">
            <Select
              value={draft.workspaceId}
              onChange={(e) => setDraft({ ...draft, workspaceId: e.target.value })}
            >
              <option value="">workspace…</option>
              {workspaces.data?.workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Loopback redirect paths (auth-code + PKCE)">
            <Input
              value={draft.redirects}
              onChange={(e) => setDraft({ ...draft, redirects: e.target.value })}
              placeholder="/callback"
            />
          </Field>
          <div className="flex items-center gap-4 text-[11.5px] text-body">
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={draft.device}
                onChange={(e) => setDraft({ ...draft, device: e.target.checked })}
              />
              device flow (CLI / headless)
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={draft.authCode}
                onChange={(e) => setDraft({ ...draft, authCode: e.target.checked })}
              />
              auth-code + PKCE
            </label>
          </div>
          <div className="flex justify-end">
            <Button
              type="submit"
              variant="primary"
              disabled={
                saving || !draft.clientId.trim() || !draft.name.trim() || !draft.workspaceId
              }
            >
              {saving ? 'Saving…' : 'Register client'}
            </Button>
          </div>
        </form>
      </Panel>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel className="overflow-hidden">
          <PanelHeader title="OAuth clients" meta={`${clients.data?.clients.length ?? 0}`} />
          {clients.loading ? (
            <Spinner />
          ) : (clients.data?.clients.length ?? 0) === 0 ? (
            <EmptyState message="No registered clients." />
          ) : (
            <div>
              <GridRow cols="minmax(0,1fr) 80px 80px 70px" header>
                <Cell>Client</Cell>
                <Cell>Grants</Cell>
                <Cell>State</Cell>
                <Cell align="right"> </Cell>
              </GridRow>
              {clients.data?.clients.map((c: OAuthClient) => (
                <GridRow key={c.clientId} cols="minmax(0,1fr) 80px 80px 70px">
                  <div className="min-w-0">
                    <div className="truncate text-[11.5px] text-ink">{c.name}</div>
                    <div className="font-mono text-[9px] text-secondary">{c.clientId}</div>
                  </div>
                  <Cell mono tone="secondary">
                    {c.grantTypes.length}
                  </Cell>
                  <Cell>
                    <StatusChip tone={c.enabled ? 'green' : 'neutral'}>
                      {c.enabled ? 'enabled' : 'off'}
                    </StatusChip>
                  </Cell>
                  <div className="flex justify-end">
                    <Button
                      variant="ghost"
                      onClick={async () => {
                        if (!api || !window.confirm(`Delete client "${c.clientId}"?`)) return;
                        try {
                          await api.deleteOAuthClient(c.clientId);
                          clients.refetch();
                        } catch (e) {
                          setError(msg(e));
                        }
                      }}
                    >
                      Delete
                    </Button>
                  </div>
                </GridRow>
              ))}
            </div>
          )}
        </Panel>

        <Panel className="overflow-hidden">
          <PanelHeader
            title="Active grants (token families)"
            meta={`${grants.data?.grants.length ?? 0}`}
          />
          {grants.loading ? (
            <Spinner />
          ) : (grants.data?.grants.length ?? 0) === 0 ? (
            <EmptyState message="No issued grants." />
          ) : (
            <div className="max-h-[360px] overflow-y-auto">
              <GridRow cols="minmax(0,1fr) 90px 80px 70px" header>
                <Cell>Principal</Cell>
                <Cell>Client</Cell>
                <Cell>State</Cell>
                <Cell align="right"> </Cell>
              </GridRow>
              {grants.data?.grants.map((g: OAuthGrant) => (
                <GridRow key={g.handle} cols="minmax(0,1fr) 90px 80px 70px">
                  <Cell mono tone="ink">
                    {g.principalId}
                  </Cell>
                  <Cell mono tone="secondary">
                    {g.clientId}
                  </Cell>
                  <Cell>
                    <StatusChip tone={g.status === 'active' ? 'green' : 'red'}>
                      {g.status}
                    </StatusChip>
                  </Cell>
                  <div className="flex justify-end">
                    {g.status === 'active' ? (
                      <Button
                        variant="ghost"
                        onClick={async () => {
                          if (!api) return;
                          try {
                            await api.revokeOAuthGrant(g.handle);
                            grants.refetch();
                          } catch (e) {
                            setError(msg(e));
                          }
                        }}
                      >
                        Revoke
                      </Button>
                    ) : null}
                  </div>
                </GridRow>
              ))}
            </div>
          )}
        </Panel>
      </div>

      {alerts.length > 0 ? (
        <Panel>
          <PanelHeader title="Refresh-reuse alerts" meta="theft signal" />
          <div className="p-3">
            <CodeBlock terminal className="max-h-[220px]">
              {JSON.stringify(alerts, null, 2)}
            </CodeBlock>
          </div>
        </Panel>
      ) : null}
    </div>
  );
}

function OnboardingTab() {
  const { api } = useAdmin();
  const workspaces = useAdminQuery((a) => a.workspaces(), []);
  const [ws, setWs] = useState('');
  const [agent, setAgent] = useState<ClientAgent>('claude-code');
  const [auth, setAuth] = useState<ClientAuthMode>('oauth');
  const [config, setConfig] = useState<GeneratedClientConfig | null>(null);
  const [pack, setPack] = useState<unknown>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const opts = { agent, auth };

  return (
    <div className="flex flex-col gap-4">
      {error ? <ErrorNote error={error} /> : null}
      <Panel>
        <PanelHeader
          title="Turnkey onboarding"
          meta="point Claude Code / Codex at the gateway"
          right={
            <Select value={ws} onChange={(e) => setWs(e.target.value)}>
              <option value="">workspace…</option>
              {workspaces.data?.workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
          }
        />
        <div className="flex flex-wrap items-center gap-3 px-3.5 pt-3.5">
          <SegmentedControl<ClientAgent>
            value={agent}
            onChange={setAgent}
            options={[
              { value: 'claude-code', label: 'Claude Code' },
              { value: 'codex', label: 'Codex' },
            ]}
          />
          <SegmentedControl<ClientAuthMode>
            value={auth}
            onChange={setAuth}
            options={[
              { value: 'oauth', label: 'OAuth (device login)' },
              { value: 'virtual-key', label: 'Virtual key' },
            ]}
          />
        </div>
        <div className="flex gap-2 p-3.5">
          <Button
            disabled={!ws}
            onClick={async () => {
              if (!api || !ws) return;
              setError(undefined);
              try {
                setConfig((await api.clientConfig(ws, opts)).config);
              } catch (e) {
                setError(
                  isNotConfigured(msg(e)) ? 'Client config needs GATEWAY_PUBLIC_URL.' : msg(e),
                );
              }
            }}
          >
            Client config
          </Button>
          <Button
            disabled={!ws}
            onClick={async () => {
              if (!api || !ws) return;
              setError(undefined);
              try {
                setPack(await api.onboardingPack(ws, opts));
              } catch (e) {
                setError(isNotConfigured(msg(e)) ? 'Onboarding pack needs a signing key.' : msg(e));
              }
            }}
          >
            Signed onboarding pack
          </Button>
        </div>
      </Panel>

      {config ? (
        <Panel>
          <PanelHeader
            title={`Client config — ${config.path}`}
            meta={config.auth === 'oauth' ? 'OAuth device login' : 'virtual key'}
          />
          <div className="p-3">
            <CodeBlock className="max-h-[280px]">{config.content}</CodeBlock>
            <ul className="mt-3 list-disc pl-5 text-[11.5px] leading-[1.7] text-body">
              {config.notes.map((n) => (
                <li key={n} className="font-mono">
                  {n}
                </li>
              ))}
            </ul>
          </div>
        </Panel>
      ) : null}
      {pack ? (
        <Panel>
          <PanelHeader title="Signed onboarding pack" meta="verify with the org public key" />
          <div className="p-3">
            <CodeBlock terminal className="max-h-[280px]">
              {JSON.stringify(pack, null, 2)}
            </CodeBlock>
          </div>
        </Panel>
      ) : null}
    </div>
  );
}
