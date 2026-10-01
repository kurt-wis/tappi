import { handler, ok, ApiError } from "@/lib/http";
import { createClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const GET = handler(async () => {
  const supabase = await createClient();
  const { data: userData, error } = await supabase.auth.getUser();
  if (error || !userData.user) throw ApiError.unauthorized();
  const { data, error: dashboardError } = await supabaseAdmin().rpc("student_dashboard", { p_user_id: userData.user.id });
  if (dashboardError) throw dashboardError;
  if (!data) throw ApiError.forbidden("This account is not linked to a student record");
  return ok(data);
});
