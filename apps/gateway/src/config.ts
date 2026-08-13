import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  GATEWAY_HOST: z.string().default('0.0.0.0'),
  GATEWAY_PORT: z.coerce.number().int().positive().default(8080),

  // Virtual-key pepper (KMS-held in prod). Optional so the server boots for
  // health checks; the proxy routes require it via the production context.
  GULLEY_KEY_PEPPER: z.string().min(1).optional(),

  // Upstream provider credentials held centrally by the gateway (v1). A provider
  // route is registered only when its key is present.
  ANTHROPIC_UPSTREAM_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_BASE_URL: z.string().url().default('https://api.anthropic.com'),
  OPENAI_UPSTREAM_API_KEY: z.string().min(1).optional(),
  OPENAI_BASE_URL: z.string().url().default('https://api.openai.com'),
  BEDROCK_UPSTREAM_API_KEY: z.string().min(1).optional(),
  BEDROCK_REGION: z.string().default('us-east-1'),
  // Azure AI Foundry / Azure OpenAI: resource endpoint + api-key (Entra later).
  AZURE_ENDPOINT: z.string().url().optional(),
  AZURE_UPSTREAM_API_KEY: z.string().min(1).optional(),

  DATABASE_URL: z.string().url().optional(),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  return Env.parse(source);
}
