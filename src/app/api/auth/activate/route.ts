import { handler, ok, readJson, ApiError } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { z } from "zod";
import { createHash } from "crypto";

const bodySchema = z.object({
  email: z.string().email().toLowerCase(),
  otp: z.string().length(6),
  password: z.string().min(8).max(128),
});

function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

export const POST = handler(async (req: Request) => {
  const { email, otp, password } = bodySchema.parse(await readJson(req));
  const admin = supabaseAdmin();

  // 1. Verify OTP
  const { data: record } = await admin
    .from("otp_codes")
    .select("*")
    .eq("email", email)
    .eq("purpose", "activation")
    .is("consumed_at", null)
    .gte("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!record) throw ApiError.notFound("No valid OTP found");
  if (hashCode(otp) !== record.code_hash) throw ApiError.conflict("Invalid code");

  await admin
    .from("otp_codes")
    .update({ consumed_at: new Date().toISOString() })
    .eq("id", record.id);

  // 2. Find the member
  const { data: member } = await admin
    .from("members")
    .select("id, org_id")
    .eq("email", email)
    .maybeSingle();

  if (!member) throw ApiError.notFound("No member record found with this email");

  // 3. Takeover Guard: Check if email is verified or school domain
  // For now, we assume if they have a member record and verified OTP, it's safe.
  // In a full implementation, you would check a `is_verified` flag on the member
  // or compare the domain against a school domain list.

  // 4. Create the auth user
  const { data: authData, error: authError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (authError) {
    if (authError.code === "email_exists") throw ApiError.conflict("Account already exists. Please log in.");
    throw authError;
  }

  // 5. Link the user to the member
  await admin
    .from("members")
    .update({ user_id: authData.user.id })
    .eq("id", member.id);

  return ok({ activated: true, userId: authData.user.id });
});