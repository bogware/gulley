import { randomUUID } from 'node:crypto';

import { versionHash } from './hash';
import { extractVariables } from './render';
import type {
  ChainVerification,
  CreatePromptArgs,
  PromptSummary,
  PromptTemplate,
  PromptVersion,
} from './types';

export class PromptNameConflictError extends Error {
  constructor(name: string) {
    super(`prompt "${name}" already exists in this workspace`);
    this.name = 'PromptNameConflictError';
  }
}

function summarize(t: PromptTemplate): PromptSummary {
  const head = t.versions[t.versions.length - 1];
  return {
    id: t.id,
    workspaceId: t.workspaceId,
    name: t.name,
    latestVersion: head?.version ?? 0,
    headHash: head?.hash ?? '',
    updatedAt: head?.createdAt ?? '',
  };
}

/** Read/write surface for the governed prompt registry, so the control-api and a
 *  future Postgres adapter share one contract. */
export interface PromptRegistry {
  create(workspaceId: string, name: string, args: CreatePromptArgs): PromptTemplate;
  addVersion(id: string, args: CreatePromptArgs): PromptVersion | undefined;
  get(id: string): PromptTemplate | undefined;
  getByName(workspaceId: string, name: string): PromptTemplate | undefined;
  head(id: string): PromptVersion | undefined;
  version(id: string, version: number): PromptVersion | undefined;
  list(workspaceIds: readonly string[] | '*'): PromptSummary[];
  delete(id: string): boolean;
  verifyChain(id: string): ChainVerification | undefined;
}

/** In-memory governed prompt registry: named, workspace-scoped, versioned, and
 *  per-template hash-chained (tamper-evident). Each new version appends a row
 *  whose hash covers the previous head — editing any historical body breaks the
 *  chain from that point on (`verifyChain`). */
export class InMemoryPromptRegistry implements PromptRegistry {
  private readonly byId = new Map<string, PromptTemplate>();

  private appendVersion(t: PromptTemplate, args: CreatePromptArgs): PromptVersion {
    const prev = t.versions[t.versions.length - 1];
    const variables = extractVariables(args.body);
    const v: PromptVersion = {
      version: (prev?.version ?? 0) + 1,
      body: args.body,
      variables,
      hash: versionHash(prev?.hash ?? null, { body: args.body, variables }),
      prevHash: prev?.hash ?? null,
      createdAt: new Date().toISOString(),
      createdBy: args.createdBy,
      ...(args.message !== undefined ? { message: args.message } : {}),
    };
    t.versions.push(v);
    return v;
  }

  create(workspaceId: string, name: string, args: CreatePromptArgs): PromptTemplate {
    if (this.getByName(workspaceId, name)) throw new PromptNameConflictError(name);
    const t: PromptTemplate = { id: randomUUID(), workspaceId, name, versions: [] };
    this.appendVersion(t, args);
    this.byId.set(t.id, t);
    return t;
  }

  addVersion(id: string, args: CreatePromptArgs): PromptVersion | undefined {
    const t = this.byId.get(id);
    if (!t) return undefined;
    return this.appendVersion(t, args);
  }

  get(id: string): PromptTemplate | undefined {
    return this.byId.get(id);
  }

  getByName(workspaceId: string, name: string): PromptTemplate | undefined {
    for (const t of this.byId.values()) {
      if (t.workspaceId === workspaceId && t.name === name) return t;
    }
    return undefined;
  }

  head(id: string): PromptVersion | undefined {
    const t = this.byId.get(id);
    return t?.versions[t.versions.length - 1];
  }

  version(id: string, version: number): PromptVersion | undefined {
    return this.byId.get(id)?.versions.find((v) => v.version === version);
  }

  list(workspaceIds: readonly string[] | '*'): PromptSummary[] {
    const all = [...this.byId.values()];
    const scoped =
      workspaceIds === '*' ? all : all.filter((t) => workspaceIds.includes(t.workspaceId));
    return scoped.map(summarize);
  }

  delete(id: string): boolean {
    return this.byId.delete(id);
  }

  verifyChain(id: string): ChainVerification | undefined {
    const t = this.byId.get(id);
    if (!t) return undefined;
    return verifyChain(t.versions);
  }
}

/** Recompute every version's hash from its prevHash + content and confirm the
 *  linkage + monotonic version numbers. Reusable by any registry backend. */
export function verifyChain(versions: readonly PromptVersion[]): ChainVerification {
  let prev: PromptVersion | undefined;
  for (const v of versions) {
    const expectedPrev = prev?.hash ?? null;
    const expectedVersion = (prev?.version ?? 0) + 1;
    const recomputed = versionHash(expectedPrev, { body: v.body, variables: v.variables });
    if (v.prevHash !== expectedPrev || v.version !== expectedVersion || v.hash !== recomputed) {
      return { verified: false, count: versions.length, brokenAt: v.version };
    }
    prev = v;
  }
  return { verified: true, count: versions.length };
}
