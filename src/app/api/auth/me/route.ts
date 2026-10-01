import { handler, ok, ApiError } from "@/lib/http";
import { createClient } from "@/lib/supabase/server";

export const GET = handler(async () => {
  const supabase = await createClient();
  const { data: userData, error } = await supabase.auth.getUser();
  if (error || !userData.user) throw ApiError.unauthorized();

  // Staff profile (optional — students won't have one)
  const { data: profile } = await supabase
    .from("profiles")
    .select("id, org_id, email, full_name, role, is_active")
    .eq("id", userData.user.id)
    .maybeSingle();

  // Student records (optional — staff won't have any)
  const { data: members } = await supabase
    .from("members")
    .select("id, org_id, student_number, full_name, email, lost_card_flag")
    .eq("user_id", userData.user.id);

  if (!profile && (!members || members.length === 0)) {
    throw ApiError.forbidden("No account associated with this login");
  }

  return ok({
    user_id: userData.user.id,
    email: userData.user.email,
    role: profile?.role ?? (members && members.length > 0 ? "student" : null),
    is_staff: Boolean(profile),
    is_student: Boolean(members && members.length > 0),
    profile: profile ?? null,
    members: members ?? [],
  });
});