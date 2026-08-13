/**
 * Live Bedrock Guardrails check. Applies a real, pre-provisioned Bedrock
 * guardrail to clean vs offending text via the ApplyGuardrail REST API and
 * asserts the plugin maps the verdicts correctly (clean -> none; offending ->
 * blocked or masked). Provision the guardrail first (see M4 notes) and pass:
 *
 *   GULLEY_BEDROCK_GUARDRAIL_ID=<id> \
 *   GULLEY_BEDROCK_GUARDRAIL_VERSION=DRAFT \
 *   GULLEY_BEDROCK_GUARDRAIL_TRIGGER="BLOCKME" \
 *   pnpm --filter @gulley/gateway run bedrock-guardrail:check
 */
import { BedrockGuardrailPlugin, closeUpstreamPool } from '@gulley/providers';

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v && v.trim()) return v.trim();
  if (fallback !== undefined) return fallback;
  throw new Error(`missing required env ${name}`);
}

async function main(): Promise<void> {
  const apiKey = env('BEDROCK_API_KEY');
  const guardrailId = env('GULLEY_BEDROCK_GUARDRAIL_ID');
  const version = env('GULLEY_BEDROCK_GUARDRAIL_VERSION', 'DRAFT');
  const region = env('BEDROCK_REGION', 'us-east-1');
  const mode = env('GULLEY_BEDROCK_GUARDRAIL_MODE', 'block') as 'block' | 'mask';
  const trigger = env('GULLEY_BEDROCK_GUARDRAIL_TRIGGER', 'BLOCKME');

  const plugin = new BedrockGuardrailPlugin({
    guardrailId,
    guardrailVersion: version,
    apiKey,
    region,
    mode,
    failClosed: false,
  });

  try {
    const clean = await plugin.inspect('The weather is pleasant this afternoon.', 'input');
    const dirty = await plugin.inspect(`Please ${trigger} right now.`, 'input');

    process.stdout.write(`clean     -> action=${clean.action} findings=${clean.findings.length}\n`);
    process.stdout.write(
      `offending -> action=${dirty.action} findings=${dirty.findings.length}` +
        (dirty.maskedText ? ` masked="${dirty.maskedText.slice(0, 60)}"` : '') +
        '\n',
    );

    const pass = clean.action === 'none' && dirty.action !== 'none';
    process.stdout.write(
      pass ? '✅ BEDROCK GUARDRAIL CHECK PASSED\n' : '❌ BEDROCK GUARDRAIL CHECK FAILED\n',
    );
    if (!pass) throw new Error('expected clean=none and offending to intervene');
  } finally {
    await closeUpstreamPool();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
