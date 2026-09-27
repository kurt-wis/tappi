import { ok } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { env } from "@/lib/env";

export async function GET() {
  const { count } = await supabaseAdmin()
    .from("organizations")
    .select("*", { count: "exact", head: true });
  return ok({ db: "ok", orgs: count ?? 0, appUrl: env.APP_URL });
}