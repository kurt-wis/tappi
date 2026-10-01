import { handler, ok, readJson, ApiError } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { env } from "@/lib/env";
import { z } from "zod";
import { createHash, randomInt } from "crypto";
import { Resend } from "resend";

const bodySchema = z.object({
  email: z.string().email().toLowerCase(),
  purpose: z.enum(["signup", "activation", "autofill"]),
});

function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

export const POST = handler(async (req: Request) => {
  const { email, purpose } = bodySchema.parse(await readJson(req));
  const admin = supabaseAdmin();

  // Rate limit: max 1 OTP per email per minute
  const oneMinuteAgo = new Date(Date.now() - 60 * 1000).toISOString();
  const { data: recent } = await admin
    .from("otp_codes")
    .select("id")
    .eq("email", email)
    .eq("purpose", purpose)
    .gte("created_at", oneMinuteAgo)
    .maybeSingle();

  if (recent) throw ApiError.conflict("Please wait a minute before requesting a new code");

  // Generate 6-digit OTP
  const otp = String(randomInt(100000, 999999));
  const codeHash = hashCode(otp);

  // Find person if purpose is activation/autofill
  let personId: string | null = null;
  if (purpose === "activation" || purpose === "autofill") {
    const { data: person } = await admin
      .from("persons")
      .select("id")
      .eq("email", email)
      .maybeSingle();
    if (!person) throw ApiError.notFound("No account found with this email");
    personId = person.id;
  }

  const { error } = await admin.from("otp_codes").insert({
    email,
    code_hash: codeHash,
    purpose,
    person_id: personId,
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  });

  if (error) throw new ApiError("internal_error", "Could not create OTP", 500);

  if (env.RESEND_API_KEY) {
    const resend = new Resend(env.RESEND_API_KEY);
    await resend.emails.send({
      from: env.EMAIL_FROM ?? "Tappi <onboarding@resend.dev>",
      to: email,
      subject: "Your Tappi verification code",
      html: `<p>Your verification code is <strong>${otp}</strong>. It expires in 10 minutes.</p>`,
    });
  } else {
    console.warn(`[otp/send] RESEND_API_KEY missing. Dev OTP for ${email}: ${otp}`);
  }

  return ok({ sent: true, purpose });
});