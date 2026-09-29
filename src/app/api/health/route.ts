import { ok } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { env } from "@/lib/env";

export async function GET() {
  const { count, error } = await supabaseAdmin()
    .from("organizations")
    .select("*", { count: "exact", head: true });
  if (error) {
    return Response.json(
      { ok: false, error: { code: "service_unavailable", message: "Database health check failed" } },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  return ok({ db: "ok", orgs: count ?? 0, appUrl: env.APP_URL });
}
