import { createHash } from 'node:crypto';

const GENESIS = 'GENESIS';

/** The fields a version's hash covers. Authorship (who/when/why) is part of the
 *  chained content: without it a historical version's author or timestamp could be
 *  rewritten without breaking the chain, which defeats the point of a governed,
 *  tamper-evident prompt history. */
export interface VersionContent {
  body: string;
  variables: readonly string[];
  createdBy: string;
  createdAt: string;
  message?: string;
}

/** Deterministic hash of a version's content, chained to the previous version's
 *  hash. Canonicalized as JSON with a fixed key order so field order is irrelevant;
 *  the leading `prevHash` is what makes the chain tamper-evident (editing an old
 *  version changes its hash, which breaks every later `prevHash` link). */
export function versionHash(prevHash: string | null, content: VersionContent): string {
  const canonical = JSON.stringify({
    body: content.body,
    variables: content.variables,
    createdBy: content.createdBy,
    createdAt: content.createdAt,
    message: content.message ?? null,
  });
  return createHash('sha256')
    .update(`${prevHash ?? GENESIS}\n${canonical}`)
    .digest('hex');
}
