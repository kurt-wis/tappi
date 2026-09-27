import { ApiError, handler, ok } from "@/lib/http";
import { requireAuth } from "@/lib/supabase/server";

export const GET = handler(async () => {
  const { supabase, userId, orgId } = await requireAuth();
  const { data: profile, error } = await supabase.from("profiles")
    .select("id, org_id, email, full_name, role, is_active, created_at, updated_at, org:organizations(id, name, slug, logo_url, settings, created_at, updated_at)")
    .eq("id", userId).eq("org_id", orgId).maybeSingle();
  if (error) throw error;
  if (!profile) throw ApiError.forbidden("No profile for this account");
  return ok(profile, { headers: { "Cache-Control": "private, no-store" } });
});
