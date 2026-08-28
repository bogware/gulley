import { createHash } from 'node:crypto';

const GENESIS = 'GENESIS';

/** Deterministic hash of a version's content, chained to the previous version's
 *  hash. Canonicalized as JSON so field order is irrelevant; the leading
 *  `prevHash` is what makes the chain tamper-evident (editing an old body changes
 *  its hash, which breaks every later `prevHash` link). */
export function versionHash(
  prevHash: string | null,
  content: { body: string; variables: readonly string[] },
): string {
  const canonical = JSON.stringify({ body: content.body, variables: content.variables });
  return createHash('sha256')
    .update(`${prevHash ?? GENESIS}\n${canonical}`)
    .digest('hex');
}
