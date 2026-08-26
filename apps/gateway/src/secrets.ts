import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { MapSecretResolver, type SecretResolver } from '@gulley/core';
import type { Config } from './config';

/**
 * Production `SecretResolver` over AWS Secrets Manager. Resolves a provider
 * credential ARN to its value at reload time (the DB stores ARNs, never values).
 * A missing/invalid secret throws so the reconcile aborts atomically.
 */
export class AwsSecretsManagerResolver implements SecretResolver {
  private readonly client: SecretsManagerClient;
  constructor(region?: string) {
    this.client = new SecretsManagerClient(region ? { region } : {});
  }
  async resolve(ref: { secretArn: string; secretVersion: string }): Promise<string> {
    // A version stage (AWSCURRENT/AWSPENDING/…) vs. a concrete version id.
    const isStage = /^AWS[A-Z]+$/.test(ref.secretVersion);
    const res = await this.client.send(
      new GetSecretValueCommand({
        SecretId: ref.secretArn,
        ...(isStage ? { VersionStage: ref.secretVersion } : { VersionId: ref.secretVersion }),
      }),
    );
    if (typeof res.SecretString !== 'string') {
      throw new Error(`secret ${ref.secretArn} has no string value`);
    }
    return res.SecretString;
  }
}

/**
 * The resolver for the DB config path. `SECRETS_LOCAL_MAP` (a JSON `{arn: value}`)
 * selects the in-process resolver for dev/tests; otherwise AWS Secrets Manager.
 */
export function buildSecretResolver(config: Config): SecretResolver {
  if (config.SECRETS_LOCAL_MAP) {
    const map = JSON.parse(config.SECRETS_LOCAL_MAP) as Record<string, string>;
    return new MapSecretResolver(new Map(Object.entries(map)));
  }
  return new AwsSecretsManagerResolver(config.SECRETS_REGION);
}
