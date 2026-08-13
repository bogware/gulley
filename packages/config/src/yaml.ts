import { err, ok, type Result } from '@gulley/core';
import { assertNoInlineSecret } from '@gulley/pipeline';
import { parse, stringify } from 'yaml';
import { canonicalize } from './canonical';
import { type ConfigDocument, isConfigDocument } from './document';

/** Serialize a document to canonical YAML. Runs the secret guard BEFORE emitting
 *  so an inline secret fails the export (never written to disk / a PR). */
export function toYaml(doc: ConfigDocument): string {
  assertNoInlineSecret(doc);
  return stringify(canonicalize(doc), { sortMapEntries: true });
}

/** Parse YAML into a document. Bounds alias expansion (billion-laughs) and
 *  rejects anything that isn't a gulley/v1 document. */
export function fromYaml(text: string): Result<ConfigDocument, string> {
  let parsed: unknown;
  try {
    parsed = parse(text, { maxAliasCount: 100 });
  } catch (e) {
    return err(`yaml parse failed: ${(e as Error).message}`);
  }
  if (!isConfigDocument(parsed)) return err('not a gulley/v1 config document');
  try {
    assertNoInlineSecret(parsed);
  } catch (e) {
    return err((e as Error).message);
  }
  return ok(parsed);
}
