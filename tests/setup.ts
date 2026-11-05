import { beforeEach } from 'vitest';
import { sql } from './helpers';

// Limits are per user and per hour, so counters from earlier tests would otherwise leak in.
beforeEach(async () => {
  await sql`delete from public.rate_limits`;
});
