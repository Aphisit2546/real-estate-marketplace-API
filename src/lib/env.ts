import { z } from 'zod';

const schema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  SUPABASE_JWT_SECRET: z.string().optional(),
  ALLOWED_ORIGINS: z.string().default(''),
  WEB_URL: z.string().url().default('http://localhost:3000'),
  INTERNAL_PROXY_SECRET: z.string().optional(),
  CRON_SECRET: z.string().optional(),
  EXPO_PUSH_ENABLED: z.string().default('false'),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/** Parsed lazily so `next build` works without runtime secrets. */
export function env(): Env {
  cached ??= schema.parse(process.env);
  return cached;
}
