import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  CONTROL_API_HOST: z.string().default('0.0.0.0'),
  CONTROL_API_PORT: z.coerce.number().int().positive().default(8081),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  return Env.parse(source);
}
