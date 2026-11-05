import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from './env';

/** A fresh client per call: auth methods keep session state in memory, which must not be shared between users. */
export function adminClient(): SupabaseClient {
  return createClient(env().SUPABASE_URL, env().SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export function publicUrl(bucket: string, path: string | null | undefined): string | null {
  return path ? `${env().SUPABASE_URL}/storage/v1/object/public/${bucket}/${path}` : null;
}
