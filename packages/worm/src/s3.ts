import type { AuditMirror, MirrorBatch, MirrorObjectRef } from './batch';

export interface S3MirrorOptions {
  bucket: string;
  region: string;
  prefix?: string;
  /** Per-object COMPLIANCE retention. Keep short for throwaway/test buckets. */
  retentionDays: number;
}

interface S3Body {
  transformToString(): Promise<string>;
}
interface S3Api {
  send: (
    cmd: unknown,
  ) => Promise<{ VersionId?: string; Body?: S3Body; Contents?: Array<{ Key?: string }> }>;
  PutObjectCommand: new (input: unknown) => unknown;
  GetObjectCommand: new (input: unknown) => unknown;
  ListObjectsV2Command: new (input: unknown) => unknown;
}

/**
 * S3 Object Lock (COMPLIANCE) audit mirror — the retained WORM system of record.
 * Object keys are deterministic from the batch's seq window, so a crash-resume
 * re-ships the identical object (idempotent). The AWS SDK is imported lazily so
 * the container boots without it.
 */
export class S3AuditMirror implements AuditMirror {
  private client: unknown;

  constructor(private readonly opts: S3MirrorOptions) {}

  private async s3(): Promise<S3Api> {
    const mod = (await import('@aws-sdk/client-s3')) as unknown as {
      S3Client: new (cfg: { region: string }) => { send: (cmd: unknown) => Promise<unknown> };
      PutObjectCommand: new (input: unknown) => unknown;
      GetObjectCommand: new (input: unknown) => unknown;
      ListObjectsV2Command: new (input: unknown) => unknown;
    };
    if (!this.client) this.client = new mod.S3Client({ region: this.opts.region });
    const client = this.client as { send: (cmd: unknown) => Promise<never> };
    return {
      send: (cmd) => client.send(cmd),
      PutObjectCommand: mod.PutObjectCommand,
      GetObjectCommand: mod.GetObjectCommand,
      ListObjectsV2Command: mod.ListObjectsV2Command,
    };
  }

  private get prefix(): string {
    return this.opts.prefix ?? 'audit/';
  }

  private keyFor(batch: MirrorBatch): string {
    return `${this.prefix}batch-${String(batch.firstSeq).padStart(12, '0')}-${batch.lastSeq}.json`;
  }

  async put(batch: MirrorBatch): Promise<MirrorObjectRef> {
    const s3 = await this.s3();
    const key = this.keyFor(batch);
    const retainUntil = new Date(Date.now() + this.opts.retentionDays * 86_400_000);
    const res = await s3.send(
      new s3.PutObjectCommand({
        Bucket: this.opts.bucket,
        Key: key,
        Body: JSON.stringify(batch),
        ContentType: 'application/json',
        ObjectLockMode: 'COMPLIANCE',
        ObjectLockRetainUntilDate: retainUntil,
      }),
    );
    return { key, versionId: res.VersionId };
  }

  async list(): Promise<MirrorObjectRef[]> {
    const s3 = await this.s3();
    const res = await s3.send(
      new s3.ListObjectsV2Command({ Bucket: this.opts.bucket, Prefix: this.prefix }),
    );
    return (res.Contents ?? [])
      .map((c) => c.Key)
      .filter((k): k is string => typeof k === 'string')
      .map((key) => ({ key }));
  }

  async get(ref: MirrorObjectRef): Promise<MirrorBatch> {
    const s3 = await this.s3();
    const res = await s3.send(new s3.GetObjectCommand({ Bucket: this.opts.bucket, Key: ref.key }));
    if (!res.Body) throw new Error(`empty mirror object: ${ref.key}`);
    return JSON.parse(await res.Body.transformToString()) as MirrorBatch;
  }
}
