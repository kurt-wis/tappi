import { handler, ok, readJson, ApiError } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { z } from "zod";
import { createHash } from "crypto";

const bodySchema = z.object({
  email: z.string().email().toLowerCase(),
  otp: z.string().length(6),
  purpose: z.enum(["signup", "activation", "autofill"]),
});

function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

export const POST = handler(async (req: Request) => {
  const { email, otp, purpose } = bodySchema.parse(await readJson(req));
  const admin = supabaseAdmin();

  const { data: record } = await admin
    .from("otp_codes")
    .select("*")
    .eq("email", email)
    .eq("purpose", purpose)
    .is("consumed_at", null)
    .gte("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!record) throw ApiError.notFound("No valid OTP found. Please request a new one.");
  if (hashCode(otp) !== record.code_hash) throw ApiError.conflict("Invalid code");

  await admin
    .from("otp_codes")
    .update({ consumed_at: new Date().toISOString() })
    .eq("id", record.id);

  return ok({ verified: true, memberId: record.member_id });
});