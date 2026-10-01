import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";
import { ApiError } from "@/lib/http";

type CookieToSet = { name: string; value: string; options: CookieOptions };

export async function createClient(): Promise<SupabaseClient> {
  const cookieStore = await cookies();

  return createServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (toSet: CookieToSet[]) => {
          try {
            toSet.forEach(({ name, value, options }: CookieToSet) =>
              cookieStore.set(name, value, options),
            );
          } catch {

          }
        },
      },
    },
  );
}

export type AuthContext = {
  supabase: SupabaseClient;
  userId: string;
  orgId: string;
  role: "org_admin" | "officer" | "scanner_operator";
};

export async function requireAuth(): Promise<AuthContext> {
  const supabase = await createClient();
  const { data: userData, error } = await supabase.auth.getUser();

  if (error || !userData.user) throw ApiError.unauthorized();

  const { data: profile, error: pErr } = await supabase
    .from("profiles")
    .select("org_id, role, is_active")
    .eq("id", userData.user.id)
    .single();

  if (pErr || !profile) throw ApiError.forbidden("No profile for this account");
  if (!profile.is_active) throw ApiError.forbidden("Account is deactivated");

  return {
    supabase,
    userId: userData.user.id,
    orgId: profile.org_id as string,
    role: profile.role as AuthContext["role"],
  };
}

export function requireRole(
  ctx: AuthContext,
  allowed: Array<AuthContext["role"]>,
): void {
  if (ctx.role === "org_admin") return;
  if (!allowed.includes(ctx.role)) throw ApiError.forbidden();
}
