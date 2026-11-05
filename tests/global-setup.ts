import { startFakeSupabase, startTestDatabase } from '@rem/testing';

export default async function setup() {
  const db = await startTestDatabase();
  const supabase = await startFakeSupabase(db.sql);

  process.env.DATABASE_URL = db.url;
  process.env.SUPABASE_URL = supabase.url;
  process.env.SUPABASE_SERVICE_ROLE_KEY = supabase.serviceKey;
  process.env.WEB_URL = 'http://localhost:3000';
  process.env.CRON_SECRET = 'test-cron-secret';

  return async () => {
    await supabase.stop();
    await db.stop();
  };
}
