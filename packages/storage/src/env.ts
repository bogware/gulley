import { z } from 'zod';

const StorageEnv = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_CACHE_URL: z.string().url(),
  REDIS_COUNTERS_URL: z.string().url(),
  REDIS_VECTOR_URL: z.string().url(),
});

export type StorageEnv = z.infer<typeof StorageEnv>;

export function loadStorageEnv(source: NodeJS.ProcessEnv = process.env): StorageEnv {
  return StorageEnv.parse(source);
}
