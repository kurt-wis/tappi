import "server-only";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { env, requireServiceRoleKey } from "@/lib/env";

let cached: SupabaseClient | null = null;

export function supabaseAdmin(): SupabaseClient {
  if (cached) return cached;

  cached = createSupabaseClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    requireServiceRoleKey(),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  return cached;
}
