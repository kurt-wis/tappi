import { z } from "zod";
import { ApiError, handler, ok, readJson } from "@/lib/http";
import { createClient } from "@/lib/supabase/server";

const loginSchema = z.object({
  email: z.string().trim().email().max(254).toLowerCase(),
  password: z.string().min(1).max(128),
}).strict();

const profileSchema = z.object({
  org_id: z.string().uuid(),
  role: z.enum(["org_admin", "officer", "scanner_operator"]),
  is_active: z.literal(true),
});

export const POST = handler(async (request: Request) => {
  const input = loginSchema.parse(await readJson(request));
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword(input);
  if (error || !data.user) throw ApiError.unauthorized("Invalid email or password");

  try {
    const { data: profile, error: profileError } = await supabase.from("profiles")
      .select("org_id, role, is_active").eq("id", data.user.id).maybeSingle();
    if (profileError) throw profileError;
    const parsed = profileSchema.safeParse(profile);
    if (!parsed.success) throw ApiError.forbidden("Account has no active organization profile");
    return ok({ user_id: data.user.id, org_id: parsed.data.org_id, role: parsed.data.role });
  } catch (profileError) {
    const { error: logoutError } = await supabase.auth.signOut({ scope: "local" });
    if (logoutError) throw logoutError;
    throw profileError;
  }
});
