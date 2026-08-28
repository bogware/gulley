/** One immutable revision of a prompt template. Versions form a per-template
 *  hash chain (`hash` covers `prevHash` + the content), so any tampering with an
 *  earlier revision is detectable — the same tamper-evidence the audit sink uses. */
export interface PromptVersion {
  /** 1-based, strictly increasing per template. */
  version: number;
  /** The template text, with `{{ variable }}` placeholders. */
  body: string;
  /** Variable names referenced by the body (sorted, deduped) — derived from it,
   *  so a render can validate its inputs. */
  variables: string[];
  /** sha256 hex over `prevHash` + the canonical content of this version. */
  hash: string;
  /** The previous version's `hash`, or null for the genesis (v1). */
  prevHash: string | null;
  createdAt: string;
  createdBy: string;
  /** Optional change note (audited alongside). */
  message?: string;
}

/** A named, workspace-scoped prompt template with its full append-only history. */
export interface PromptTemplate {
  id: string;
  workspaceId: string;
  /** Unique within a workspace. */
  name: string;
  /** Append-only, ordered by `version` ascending; never empty. */
  versions: PromptVersion[];
}

/** A secret-free summary for listing (no bodies). */
export interface PromptSummary {
  id: string;
  workspaceId: string;
  name: string;
  latestVersion: number;
  headHash: string;
  updatedAt: string;
}

export interface CreatePromptArgs {
  body: string;
  createdBy: string;
  message?: string;
}

export interface ChainVerification {
  verified: boolean;
  /** Number of versions checked. */
  count: number;
  /** The first version whose hash/linkage failed, if any. */
  brokenAt?: number;
}
