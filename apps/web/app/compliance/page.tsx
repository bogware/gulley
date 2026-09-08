'use client';

import { useState } from 'react';
import {
  Button,
  Cell,
  CodeBlock,
  Dot,
  EmptyState,
  ErrorNote,
  GridRow,
  InlineResult,
  Input,
  JsonBlock,
  MicroLabel,
  PageHeader,
  Panel,
  PanelHeader,
  Spinner,
  StatusChip,
  Tabs,
} from '../../components/ui';
import { isNotConfigured } from '../../lib/api';
import { useAdmin } from '../../lib/admin-context';
import { formatTime } from '../../lib/format';
import { useAdminQuery } from '../../lib/hooks';
import type { AuditEvent } from '../../lib/types';

type Tab = 'audit' | 'worm' | 'anchor' | 'siem' | 'privacy';

export default function CompliancePage() {
  const [tab, setTab] = useState<Tab>('audit');
  const verify = useAdminQuery((a) => a.verifyAudit(), []);

  return (
    <div>
      <PageHeader
        title="Compliance & WORM"
        subtitle="Tamper-evident audit trail, immutable mirror, external anchoring, SIEM export, and right-to-erasure."
        actions={
          verify.data ? (
            <span className="flex items-center gap-1.5 font-mono text-[10px] text-secondary">
              <Dot tone={verify.data.verified ? 'green' : 'red'} />
              chain {verify.data.verified ? `verified · ${verify.data.count} rows` : 'unverified'}
            </span>
          ) : undefined
        }
      />
      <div className="mb-4">
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'audit', label: 'Audit & attestation' },
            { value: 'worm', label: 'WORM' },
            { value: 'anchor', label: 'Anchoring' },
            { value: 'siem', label: 'SIEM' },
            { value: 'privacy', label: 'Right-to-erasure' },
          ]}
        />
      </div>
      {tab === 'audit' ? <AuditTab /> : null}
      {tab === 'worm' ? <ActionTab kind="worm" /> : null}
      {tab === 'anchor' ? <AnchorTab /> : null}
      {tab === 'siem' ? <ActionTab kind="siem" /> : null}
      {tab === 'privacy' ? <PrivacyTab /> : null}
    </div>
  );
}

function NotConfigured({ what }: { what: string }) {
  return (
    <Panel>
      <PanelHeader title={`${what} not configured`} />
      <div className="p-4 text-[11.5px] text-body">
        This capability is not wired in the current deployment — enable it to use it here.
      </div>
    </Panel>
  );
}

function AuditTab() {
  const { api } = useAdmin();
  const events = useAdminQuery((a) => a.auditEvents({ limit: 100 }), []);
  const attest = useAdminQuery((a) => a.auditAttestation(), []);
  const [downloading, setDownloading] = useState(false);

  async function downloadBundle(): Promise<void> {
    if (!api) return;
    setDownloading(true);
    try {
      const bundle = await api.evidenceBundle();
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `gulley-evidence-bundle-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Panel className="overflow-hidden">
          <PanelHeader title="Audit trail" meta="hash-chained, newest first" />
          {events.loading ? (
            <Spinner />
          ) : events.error ? (
            <div className="p-3">
              <ErrorNote error={events.error} />
            </div>
          ) : (
            <div className="max-h-[520px] overflow-y-auto">
              <GridRow cols="52px 120px minmax(0,1fr) 96px" header>
                <Cell>Seq</Cell>
                <Cell>Action</Cell>
                <Cell>Actor · target</Cell>
                <Cell align="right">When</Cell>
              </GridRow>
              {(events.data?.events ?? []).map((e: AuditEvent) => (
                <GridRow key={e.seq} cols="52px 120px minmax(0,1fr) 96px">
                  <Cell mono tone="secondary">
                    {e.seq}
                  </Cell>
                  <Cell mono tone="ink">
                    {e.action}
                  </Cell>
                  <Cell mono tone="secondary">
                    {e.actor} · {e.target}
                  </Cell>
                  <Cell align="right" mono tone="secondary">
                    {formatTime(e.createdAt)}
                  </Cell>
                </GridRow>
              ))}
            </div>
          )}
        </Panel>

        <div className="flex flex-col gap-4">
          <Panel>
            <PanelHeader title="Signed attestation" />
            <div className="p-3">
              {attest.loading ? (
                <Spinner />
              ) : attest.error ? (
                isNotConfigured(attest.error) ? (
                  <EmptyState message="Attestation signing not configured." />
                ) : (
                  <ErrorNote error={attest.error} />
                )
              ) : (
                <JsonBlock value={attest.data} />
              )}
            </div>
          </Panel>
          <Panel>
            <PanelHeader title="Evidence bundle" />
            <div className="flex flex-col gap-2 p-3.5">
              <p className="text-[11px] leading-[1.6] text-body">
                One downloadable, offline-verifiable artifact: the signed attestation, the full
                ordered rows, and a public-key hint.
              </p>
              <Button
                variant="primary"
                onClick={() => void downloadBundle()}
                disabled={downloading}
              >
                {downloading ? 'Preparing…' : 'Download evidence bundle'}
              </Button>
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}

function ActionTab({ kind }: { kind: 'worm' | 'siem' }) {
  const { api } = useAdmin();
  const status = useAdminQuery((a) => (kind === 'worm' ? a.wormStatus() : a.siemStatus()), [kind]);
  const [result, setResult] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [out, setOut] = useState<unknown>(null);

  if (status.error && isNotConfigured(status.error))
    return <NotConfigured what={kind.toUpperCase()} />;

  async function act(fn: () => Promise<unknown>, label: string): Promise<void> {
    if (!api) return;
    setResult(null);
    try {
      const r = await fn();
      setOut(r);
      setResult({ tone: 'ok', text: `${label} ok` });
      status.refetch();
    } catch (e) {
      setResult({ tone: 'err', text: e instanceof Error ? e.message : String(e) });
    }
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Panel>
        <PanelHeader
          title={kind === 'worm' ? 'WORM mirror' : 'SIEM export'}
          right={
            <div className="flex gap-2">
              {kind === 'worm' ? (
                <>
                  <Button onClick={() => void act(() => api!.wormShip(), 'Ship')}>Ship now</Button>
                  <Button onClick={() => void act(() => api!.wormVerify(), 'Verify')}>
                    Verify
                  </Button>
                </>
              ) : (
                <Button onClick={() => void act(() => api!.siemExport(), 'Export')}>
                  Export now
                </Button>
              )}
            </div>
          }
        />
        <div className="p-3">
          {status.loading ? <Spinner /> : <JsonBlock value={status.data} />}
          {result ? (
            <div className="mt-2">
              <InlineResult tone={result.tone}>{result.text}</InlineResult>
            </div>
          ) : null}
        </div>
      </Panel>
      {out ? (
        <Panel>
          <PanelHeader title="Result" />
          <div className="p-3">
            <JsonBlock value={out} />
          </div>
        </Panel>
      ) : null}
    </div>
  );
}

function AnchorTab() {
  const { api } = useAdmin();
  const anchors = useAdminQuery((a) => a.anchors(), []);
  const verify = useAdminQuery((a) => a.anchorVerify(), []);
  const [result, setResult] = useState<string | null>(null);

  if (anchors.error && isNotConfigured(anchors.error)) return <NotConfigured what="Anchoring" />;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Panel>
        <PanelHeader
          title="Anchored checkpoints"
          right={
            <Button
              onClick={async () => {
                if (!api) return;
                try {
                  await api.anchorNow();
                  setResult('anchored');
                  anchors.refetch();
                  verify.refetch();
                } catch (e) {
                  setResult(e instanceof Error ? e.message : String(e));
                }
              }}
            >
              Anchor head now
            </Button>
          }
        />
        <div className="p-3">
          {anchors.loading ? <Spinner /> : <JsonBlock value={anchors.data} />}
          {result ? <div className="mt-2 text-[10px] text-secondary">{result}</div> : null}
        </div>
      </Panel>
      <Panel>
        <PanelHeader title="Rewrite detection" />
        <div className="p-3">
          {verify.loading ? <Spinner /> : <JsonBlock value={verify.data} />}
        </div>
      </Panel>
    </div>
  );
}

function PrivacyTab() {
  const { api } = useAdmin();
  const [subject, setSubject] = useState('');
  const [state, setState] = useState<{ active: boolean } | null>(null);
  const [reqId, setReqId] = useState('');
  const [reveal, setReveal] = useState<unknown>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  async function lookup(): Promise<void> {
    if (!api || !subject.trim()) return;
    setMsg(null);
    try {
      setState(await api.cryptoShredState(subject.trim()));
    } catch (e) {
      if (isNotConfigured(e instanceof Error ? e.message : String(e)))
        setMsg({ tone: 'err', text: 'Crypto-shred not enabled.' });
      else setMsg({ tone: 'err', text: e instanceof Error ? e.message : String(e) });
    }
  }
  async function shred(): Promise<void> {
    if (!api || !subject.trim()) return;
    if (
      !window.confirm(
        `Permanently crypto-shred all mask-vault PII for "${subject}"? This cannot be undone.`,
      )
    )
      return;
    try {
      await api.cryptoShred(subject.trim());
      setMsg({ tone: 'ok', text: 'Subject key destroyed — its stored PII is now unrecoverable.' });
      await lookup();
    } catch (e) {
      setMsg({ tone: 'err', text: e instanceof Error ? e.message : String(e) });
    }
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Panel>
        <PanelHeader title="Crypto-shred (GDPR/CCPA erasure)" />
        <div className="flex flex-col gap-3 p-3.5">
          <MicroLabel>Subject (virtual-key principal id)</MicroLabel>
          <div className="flex gap-2">
            <Input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="vk_… / subject id"
            />
            <Button onClick={() => void lookup()} disabled={!subject.trim()}>
              Look up
            </Button>
          </div>
          {state ? (
            <div className="flex items-center gap-2">
              <StatusChip tone={state.active ? 'green' : 'red'}>
                {state.active ? 'recoverable' : 'shredded'}
              </StatusChip>
              {state.active ? (
                <Button variant="danger" onClick={() => void shred()}>
                  Shred subject key
                </Button>
              ) : null}
            </div>
          ) : null}
          {msg ? <InlineResult tone={msg.tone}>{msg.text}</InlineResult> : null}
          <p className="text-[10px] text-micro">
            Owner-only. Destroys the per-subject key; the audit chain records the erasure.
          </p>
        </div>
      </Panel>

      <Panel>
        <PanelHeader title="Mask-vault reveal" meta="owner-only · exposes raw PII" />
        <div className="flex flex-col gap-3 p-3.5">
          <MicroLabel>Request id</MicroLabel>
          <div className="flex gap-2">
            <Input value={reqId} onChange={(e) => setReqId(e.target.value)} placeholder="req_…" />
            <Button
              onClick={async () => {
                if (!api || !reqId.trim()) return;
                try {
                  setReveal(await api.maskVaultReveal(reqId.trim()));
                } catch (e) {
                  setReveal({ error: e instanceof Error ? e.message : String(e) });
                }
              }}
              disabled={!reqId.trim()}
            >
              Reveal
            </Button>
          </div>
          {reveal ? (
            <CodeBlock terminal className="max-h-[240px]">
              {JSON.stringify(reveal, null, 2)}
            </CodeBlock>
          ) : null}
        </div>
      </Panel>
    </div>
  );
}
