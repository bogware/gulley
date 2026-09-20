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

export function summarizeTemplate(t: PromptTemplate): PromptSummary {
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

/** Build the next version of a template from its current head (pure). Shared by
 *  every registry backend so the chain is computed identically everywhere. */
export function nextVersion(
  prev: PromptVersion | undefined,
  args: CreatePromptArgs,
  now: () => Date = () => new Date(),
): PromptVersion {
  const variables = extractVariables(args.body);
  const createdAt = now().toISOString();
  const content = {
    body: args.body,
    variables,
    createdBy: args.createdBy,
    createdAt,
    ...(args.message !== undefined ? { message: args.message } : {}),
  };
  return {
    version: (prev?.version ?? 0) + 1,
    body: args.body,
    variables,
    hash: versionHash(prev?.hash ?? null, content),
    prevHash: prev?.hash ?? null,
    createdAt,
    createdBy: args.createdBy,
    ...(args.message !== undefined ? { message: args.message } : {}),
  };
}

/** Read/write surface for the governed prompt registry. Async so the durable
 *  (Postgres) adapter and the in-memory one share one contract. */
export interface PromptRegistry {
  create(workspaceId: string, name: string, args: CreatePromptArgs): Promise<PromptTemplate>;
  addVersion(id: string, args: CreatePromptArgs): Promise<PromptVersion | undefined>;
  get(id: string): Promise<PromptTemplate | undefined>;
  getByName(workspaceId: string, name: string): Promise<PromptTemplate | undefined>;
  head(id: string): Promise<PromptVersion | undefined>;
  version(id: string, version: number): Promise<PromptVersion | undefined>;
  list(workspaceIds: readonly string[] | '*'): Promise<PromptSummary[]>;
  delete(id: string): Promise<boolean>;
  verifyChain(id: string): Promise<ChainVerification | undefined>;
}

/** In-memory governed prompt registry: named, workspace-scoped, versioned, and
 *  per-template hash-chained (tamper-evident). Each new version appends a row
 *  whose hash covers the previous head — editing any historical body breaks the
 *  chain from that point on (`verifyChain`). Tests + no-DB dev only; DB mode uses
 *  the Postgres adapter in @gulley/storage. */
export class InMemoryPromptRegistry implements PromptRegistry {
  private readonly byId = new Map<string, PromptTemplate>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  private appendVersion(t: PromptTemplate, args: CreatePromptArgs): PromptVersion {
    const v = nextVersion(t.versions[t.versions.length - 1], args, this.now);
    t.versions.push(v);
    return v;
  }

  async create(workspaceId: string, name: string, args: CreatePromptArgs): Promise<PromptTemplate> {
    if (await this.getByName(workspaceId, name)) throw new PromptNameConflictError(name);
    const t: PromptTemplate = { id: randomUUID(), workspaceId, name, versions: [] };
    this.appendVersion(t, args);
    this.byId.set(t.id, t);
    return t;
  }

  async addVersion(id: string, args: CreatePromptArgs): Promise<PromptVersion | undefined> {
    const t = this.byId.get(id);
    if (!t) return undefined;
    return this.appendVersion(t, args);
  }

  async get(id: string): Promise<PromptTemplate | undefined> {
    return this.byId.get(id);
  }

  async getByName(workspaceId: string, name: string): Promise<PromptTemplate | undefined> {
    for (const t of this.byId.values()) {
      if (t.workspaceId === workspaceId && t.name === name) return t;
    }
    return undefined;
  }

  async head(id: string): Promise<PromptVersion | undefined> {
    const t = this.byId.get(id);
    return t?.versions[t.versions.length - 1];
  }

  async version(id: string, version: number): Promise<PromptVersion | undefined> {
    return this.byId.get(id)?.versions.find((v) => v.version === version);
  }

  async list(workspaceIds: readonly string[] | '*'): Promise<PromptSummary[]> {
    const all = [...this.byId.values()];
    const scoped =
      workspaceIds === '*' ? all : all.filter((t) => workspaceIds.includes(t.workspaceId));
    return scoped.map(summarizeTemplate);
  }

  async delete(id: string): Promise<boolean> {
    return this.byId.delete(id);
  }

  async verifyChain(id: string): Promise<ChainVerification | undefined> {
    const t = this.byId.get(id);
    if (!t) return undefined;
    return verifyChain(t.versions);
  }
}

/** Recompute every version's hash from its prevHash + content (body, variables,
 *  author, timestamp, message) and confirm the linkage + monotonic version numbers.
 *  Reusable by any registry backend. */
export function verifyChain(versions: readonly PromptVersion[]): ChainVerification {
  let prev: PromptVersion | undefined;
  for (const v of versions) {
    const expectedPrev = prev?.hash ?? null;
    const expectedVersion = (prev?.version ?? 0) + 1;
    const recomputed = versionHash(expectedPrev, {
      body: v.body,
      variables: v.variables,
      createdBy: v.createdBy,
      createdAt: v.createdAt,
      ...(v.message !== undefined ? { message: v.message } : {}),
    });
    if (v.prevHash !== expectedPrev || v.version !== expectedVersion || v.hash !== recomputed) {
      return { verified: false, count: versions.length, brokenAt: v.version };
    }
    prev = v;
  }
  return { verified: true, count: versions.length };
}
