import { z } from "zod";
import { ApiError, handler, ok, readJson } from "@/lib/http";
import { createClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { normalizeStudentNumber } from "@/lib/registration-form";
import { getAccount } from "@/lib/auth/account";

const schema = z.object({
  email: z.string().trim().email().max(254).toLowerCase().optional(),
  student_number: z.string().trim().min(1).max(100).optional(),
  password: z.string().min(1).max(128),
}).strict().refine((v) => Boolean(v.email) !== Boolean(v.student_number), "Provide email or student number");

export const POST = handler(async (request: Request) => {
  const input = schema.parse(await readJson(request));
  let email = input.email;
  if (!email) {
    const { data, error } = await supabaseAdmin().from("persons").select("email,logins(user_id)")
      .eq("student_number_normalized", normalizeStudentNumber(input.student_number!)).is("merged_into", null).maybeSingle();
    if (error) throw error;
    if (!data?.email || !data.logins?.length) throw ApiError.unauthorized("Invalid credentials");
    email = data.email;
  }
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email: email!, password: input.password });
  if (error || !data.user) throw ApiError.unauthorized("Invalid credentials");
  try {
    const account = await getAccount(supabase, data.user);
    return ok({ user_id: account.user_id, org_id: account.org_id, role: account.role, person_id: account.person_id });
  } catch (error) {
    await supabase.auth.signOut({ scope: "local" });
    throw error;
  }
});
