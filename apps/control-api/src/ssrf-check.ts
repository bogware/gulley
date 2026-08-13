/**
 * Live SSRF egress-guard check (real DNS). Asserts the structural guard blocks
 * IMDS/ECS-metadata/RFC1918 literals (even over https), that a real public host
 * resolves to public addresses, and that a name resolving to loopback is blocked
 * (DNS-rebind defense).
 *
 *   pnpm --filter @gulley/control-api run ssrf:check
 */
import { assertEgressAllowed, assertHostResolvesPublic, EgressError } from '@gulley/egress';

function blockedSync(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch (e) {
    return e instanceof EgressError;
  }
}

async function blockedAsync(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch (e) {
    return e instanceof EgressError;
  }
}

async function main(): Promise<void> {
  const imds = blockedSync(() => assertEgressAllowed('https://169.254.169.254/latest/meta-data/'));
  const ecs = blockedSync(() => assertEgressAllowed('https://169.254.170.2/v2/credentials'));
  const rfc1918 = blockedSync(() => assertEgressAllowed('https://10.0.0.5/'));
  const userinfo = blockedSync(() => assertEgressAllowed('https://user:pass@api.anthropic.com/'));

  let publicOk = true;
  try {
    await assertHostResolvesPublic('api.anthropic.com'); // real DNS -> public addrs
  } catch {
    publicOk = false;
  }
  const loopbackName = await blockedAsync(() => assertHostResolvesPublic('localhost'));

  process.stdout.write(
    `imds-literal:        ${imds}\n` +
      `ecs-metadata:        ${ecs}\n` +
      `rfc1918-literal:     ${rfc1918}\n` +
      `userinfo-in-url:     ${userinfo}\n` +
      `anthropic-public:    ${publicOk}\n` +
      `localhost-resolved:  ${loopbackName} (blocked)\n`,
  );

  const pass = imds && ecs && rfc1918 && userinfo && publicOk && loopbackName;
  process.stdout.write(pass ? '✅ SSRF LIVE CHECK PASSED\n' : '❌ SSRF LIVE CHECK FAILED\n');
  if (!pass) throw new Error('one or more SSRF guard behaviors did not hold');
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
