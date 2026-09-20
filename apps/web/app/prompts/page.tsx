'use client';

import { useState } from 'react';
import {
  Button,
  Cell,
  EmptyState,
  ErrorNote,
  Field,
  GridRow,
  InlineResult,
  Input,
  MicroLabel,
  PageHeader,
  Panel,
  PanelHeader,
  Select,
  Spinner,
  StatusChip,
} from '../../components/ui';
import { useAdmin } from '../../lib/admin-context';
import { useAdminQuery } from '../../lib/hooks';
import type { PromptTemplate } from '../../lib/types';

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export default function PromptsPage() {
  const { api } = useAdmin();
  const prompts = useAdminQuery((a) => a.prompts(), []);
  const workspaces = useAdminQuery((a) => a.workspaces(), []);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const [creating, setCreating] = useState(false);

  const list = prompts.data?.prompts ?? [];
  const selected = list.find((p) => p.id === selectedId) ?? list[0] ?? null;

  return (
    <div>
      <PageHeader
        title="Prompts"
        subtitle="Governed, hash-chained prompt templates — versioned, verifiable, and render-previewable."
        actions={
          <Button variant="primary" onClick={() => setCreating((c) => !c)}>
            + New prompt
          </Button>
        }
      />
      {error ? <ErrorNote error={error} /> : null}

      <div className="flex flex-col gap-4 lg:flex-row">
        <div className="w-full shrink-0 lg:w-[300px]">
          <Panel className="overflow-hidden">
            <PanelHeader title="Templates" meta={`${list.length}`} />
            {prompts.loading ? (
              <Spinner />
            ) : prompts.error ? (
              <div className="p-3">
                <ErrorNote error={prompts.error} onRetry={prompts.refetch} />
              </div>
            ) : list.length === 0 ? (
              <EmptyState message="No prompts yet." />
            ) : (
              <div className="flex flex-col">
                {list.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => {
                      setSelectedId(p.id);
                      setCreating(false);
                    }}
                    className={`flex items-center justify-between gap-2 border-b border-line-soft px-3 py-2 text-left transition-colors last:border-0 ${
                      selected?.id === p.id && !creating
                        ? 'bg-accent-tint shadow-selrow'
                        : 'hover:bg-[#F3F0E8]'
                    }`}
                  >
                    <span className="truncate font-mono text-[11.5px] text-ink">{p.name}</span>
                    <StatusChip>v{p.versions.length}</StatusChip>
                  </button>
                ))}
              </div>
            )}
          </Panel>
        </div>

        <div className="min-w-0 flex-1">
          {creating ? (
            <CreatePrompt
              workspaces={workspaces.data?.workspaces ?? []}
              onDone={() => {
                setCreating(false);
                prompts.refetch();
              }}
              onError={setError}
            />
          ) : selected ? (
            <PromptDetail
              key={selected.id}
              prompt={selected}
              onChanged={() => prompts.refetch()}
              onError={setError}
            />
          ) : (
            <Panel>
              <EmptyState message="Select or create a prompt." />
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}

function PromptDetail({
  prompt,
  onChanged,
  onError,
}: {
  prompt: PromptTemplate;
  onChanged: () => void;
  onError: (e: string) => void;
}) {
  const { api } = useAdmin();
  const [verify, setVerify] = useState<string | null>(null);
  const [newBody, setNewBody] = useState('');
  const [vars, setVars] = useState('{}');
  const [rendered, setRendered] = useState<string | null>(null);

  const latest = prompt.versions[prompt.versions.length - 1];

  return (
    <div className="flex flex-col gap-4">
      <Panel>
        <PanelHeader
          title={prompt.name}
          meta={`${prompt.versions.length} versions`}
          right={
            <div className="flex gap-2">
              <Button
                onClick={async () => {
                  if (!api) return;
                  try {
                    const r = await api.verifyPrompt(prompt.id);
                    setVerify(r.verified ? 'chain verified' : 'chain BROKEN');
                  } catch (e) {
                    onError(msg(e));
                  }
                }}
              >
                Verify chain
              </Button>
              <Button
                variant="ghost"
                onClick={async () => {
                  if (!api || !window.confirm(`Delete prompt "${prompt.name}"?`)) return;
                  try {
                    await api.deletePrompt(prompt.id);
                    onChanged();
                  } catch (e) {
                    onError(msg(e));
                  }
                }}
              >
                Delete
              </Button>
            </div>
          }
        />
        <div className="p-3">
          {verify ? (
            <div className="mb-2">
              <InlineResult tone={verify.includes('BROKEN') ? 'err' : 'ok'}>{verify}</InlineResult>
            </div>
          ) : null}
          <GridRow cols="52px minmax(0,1fr) minmax(0,1fr)" header>
            <Cell>Ver</Cell>
            <Cell>Hash</Cell>
            <Cell>Variables</Cell>
          </GridRow>
          {prompt.versions.map((v) => (
            <GridRow key={v.version} cols="52px minmax(0,1fr) minmax(0,1fr)">
              <Cell mono tone="ink">
                {v.version}
              </Cell>
              <Cell mono tone="secondary">
                {v.hash.slice(0, 16)}…
              </Cell>
              <Cell mono tone="secondary">
                {(v.variables ?? []).join(', ') || '—'}
              </Cell>
            </GridRow>
          ))}
        </div>
      </Panel>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel>
          <PanelHeader title="Add a version" />
          <div className="flex flex-col gap-2 p-3.5">
            <textarea
              className="min-h-[120px] w-full rounded-control border border-line-control bg-[#FDFCF9] px-2.5 py-2 font-mono text-[11px] text-ink shadow-field outline-none"
              placeholder="Prompt body (use {{variables}})"
              value={newBody}
              onChange={(e) => setNewBody(e.target.value)}
            />
            <Button
              variant="primary"
              disabled={!newBody.trim()}
              onClick={async () => {
                if (!api) return;
                try {
                  await api.addPromptVersion(prompt.id, newBody);
                  setNewBody('');
                  onChanged();
                } catch (e) {
                  onError(msg(e));
                }
              }}
            >
              Append version
            </Button>
          </div>
        </Panel>

        <Panel>
          <PanelHeader title="Render preview" meta={`latest v${latest?.version ?? '—'}`} />
          <div className="flex flex-col gap-2 p-3.5">
            <MicroLabel>Variables (JSON)</MicroLabel>
            <Input
              value={vars}
              onChange={(e) => setVars(e.target.value)}
              placeholder='{"name":"Alice"}'
            />
            <Button
              onClick={async () => {
                if (!api) return;
                try {
                  const v = JSON.parse(vars || '{}') as Record<string, string>;
                  setRendered((await api.renderPrompt(prompt.id, v)).rendered);
                } catch (e) {
                  onError(msg(e));
                }
              }}
            >
              Render
            </Button>
            {rendered !== null ? (
              <pre className="max-h-[160px] overflow-auto rounded-control border border-line-soft bg-inset px-2.5 py-2 font-mono text-[10.5px] leading-[1.55] text-body">
                {rendered}
              </pre>
            ) : null}
          </div>
        </Panel>
      </div>
    </div>
  );
}

function CreatePrompt({
  workspaces,
  onDone,
  onError,
}: {
  workspaces: Array<{ id: string; name: string }>;
  onDone: () => void;
  onError: (e: string) => void;
}) {
  const { api } = useAdmin();
  const [ws, setWs] = useState('');
  const [name, setName] = useState('');
  const [body, setBody] = useState('');

  return (
    <Panel>
      <PanelHeader title="New prompt" />
      <div className="flex flex-col gap-3 p-3.5">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label="Workspace">
            <Select value={ws} onChange={(e) => setWs(e.target.value)} className="w-full">
              <option value="">workspace…</option>
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Name">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="code-review-system"
            />
          </Field>
        </div>
        <Field label="Body (v1)">
          <textarea
            className="min-h-[160px] w-full rounded-control border border-line-control bg-[#FDFCF9] px-2.5 py-2 font-mono text-[11px] text-ink shadow-field outline-none"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="You are a strict reviewer for {{repo}}…"
          />
        </Field>
        <Button
          variant="primary"
          disabled={!ws || !name.trim() || !body.trim()}
          onClick={async () => {
            if (!api) return;
            try {
              await api.createPrompt(ws, name.trim(), body);
              onDone();
            } catch (e) {
              onError(msg(e));
            }
          }}
        >
          Create prompt
        </Button>
      </div>
    </Panel>
  );
}
