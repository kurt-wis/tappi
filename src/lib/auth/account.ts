import type { SupabaseClient } from "@supabase/supabase-js";
import { ApiError } from "@/lib/http";

export async function getAccount(supabase: SupabaseClient, user: { id: string; email?: string }) {
  const { data: profile, error: profileError } = await supabase.from("profiles")
    .select("id,org_id,email,full_name,role,is_active").eq("id", user.id).maybeSingle();
  if (profileError) throw profileError;
  if (profile && !profile.is_active) throw ApiError.forbidden("Account is deactivated");
  const { data: login, error: loginError } = await supabase.from("logins")
    .select("person_id").eq("user_id", user.id).maybeSingle();
  if (loginError) throw loginError;
  if (!profile && !login) throw ApiError.forbidden("No account associated with this login");
  let members: unknown[] = [];
  if (login) {
    const { data, error } = await supabase.from("members")
      .select("id,org_id,student_number,full_name,email,lost_card_flag").eq("person_id", login.person_id);
    if (error) throw error;
    members = data ?? [];
  }
  let org = null;
  if (profile) {
    const { data, error } = await supabase.from("organizations").select("id,name,slug").eq("id", profile.org_id).maybeSingle();
    if (error) throw error;
    org = data;
  }
  return {
    ...profile, user_id: user.id, email: user.email, org,
    role: profile?.role ?? "student", org_id: profile?.org_id ?? null, person_id: login?.person_id ?? null,
    is_staff: Boolean(profile), is_student: Boolean(login), profile: profile ? { ...profile, org } : null, members,
  };
}
