import { createHash, randomBytes, randomInt } from "node:crypto";
import { z } from "zod";
import { Resend } from "resend";
import { ApiError } from "@/lib/http";
import { env } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { normalizeStudentNumber } from "@/lib/registration-form";

export const emailSchema = z.string().trim().email().max(254).toLowerCase();
export const studentNumberSchema = z.string().trim().min(1).max(100)
  .transform(normalizeStudentNumber).pipe(z.string().min(1));
export const hashSecret = (value: string) => createHash("sha256").update(value).digest("hex");
export const otpProofSchema = z.object({
  email: emailSchema,
  otp: z.string().regex(/^\d{6}$/).optional(),
  verificationToken: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).refine((v) => Boolean(v.otp) !== Boolean(v.verificationToken), "Provide an OTP or verification token");

export async function sendVerificationEmail(email: string, code: string) {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) {
    throw new ApiError("internal_error", "Email delivery is not configured", 503);
  }
  const { error } = await new Resend(env.RESEND_API_KEY).emails.send({
    from: env.EMAIL_FROM, to: email, subject: "Your Tappi verification code",
    text: `Your verification code is ${code}. It expires in 10 minutes.`,
  });
  if (error) throw new ApiError("internal_error", "Could not deliver verification email", 502);
}

export async function verifyOtp(email: string, otp: string, purpose: "signup" | "activation" | "autofill") {
  const verificationToken = randomBytes(32).toString("hex");
  const { data, error } = await supabaseAdmin().rpc("verify_auth_otp", {
    p_email: email, p_code_hash: hashSecret(otp), p_purpose: purpose,
    p_token_hash: hashSecret(verificationToken),
  });
  if (error) throw error;
  if (!data?.verified) throw ApiError.conflict("Invalid, expired, or exhausted verification code");
  return { verified: true, verificationToken, person_id: data.person_id ?? null };
}

export async function sendOtp(input: { email?: string; student_number?: string; purpose: "signup" | "activation" | "autofill" }) {
  const admin = supabaseAdmin();
  let email = input.email;
  let personId: string | null = null;
  if (input.purpose !== "signup") {
    let query = admin.from("persons").select("id,email").is("merged_into", null);
    query = input.student_number ? query.eq("student_number_normalized", input.student_number) : query.eq("email", email!);
    const { data, error } = await query.maybeSingle();
    if (error) throw error;
    if (!data?.email || (email && email !== String(data.email).toLowerCase())) throw ApiError.notFound("No matching account found");
    email = String(data.email).toLowerCase();
    personId = data.id;
  }
  if (!email) throw new ApiError("validation_error", "Email is required", 422);
  const code = String(randomInt(100000, 1000000));
  const { data, error } = await admin.rpc("issue_auth_otp", {
    p_email: email, p_purpose: input.purpose, p_person_id: personId, p_code_hash: hashSecret(code),
  });
  if (error) throw error;
  if (!data) throw new ApiError("rate_limited", "Wait a minute before requesting another code", 429);
  try { await sendVerificationEmail(email, code); }
  catch (error) {
    await admin.from("otp_codes").delete().eq("id", data);
    throw error;
  }
  return { sent: true, purpose: input.purpose, maskedEmail: email.replace(/^(.).*(@.*)$/, "$1***$2") };
}

export const studentSignupSchema = z.object({
  mode: z.literal("student"), full_name: z.string().trim().min(1).max(200),
  student_number: studentNumberSchema, email: emailSchema,
  password: z.string().min(8).max(128), otp: z.string().regex(/^\d{6}$/).optional(),
  verificationToken: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();

export async function provisionStudent(input: {
  email: string; password: string; otp?: string; verificationToken?: string;
  full_name?: string; student_number?: string;
}, purpose: "signup" | "activation") {
  otpProofSchema.parse(input);
  const token = input.verificationToken ?? (await verifyOtp(input.email, input.otp!, purpose)).verificationToken;
  const admin = supabaseAdmin();
  const { data: proof, error: proofError } = await admin.from("otp_codes").select("id")
    .eq("email", input.email).eq("purpose", purpose).eq("token_hash", hashSecret(token))
    .is("consumed_at", null).gt("expires_at", new Date().toISOString()).maybeSingle();
  if (proofError) throw proofError;
  if (!proof) throw ApiError.conflict("Verification expired or already used");
  const { data, error } = await admin.auth.admin.createUser({
    email: input.email, password: input.password, email_confirm: true,
  });
  if (error) {
    if (["email_exists", "user_already_exists"].includes(error.code ?? "")) throw ApiError.conflict("Account already exists. Please log in.");
    if (error.code === "weak_password") throw new ApiError("validation_error", "Password does not meet account requirements", 422);
    throw error;
  }
  if (!data.user) throw new Error("Account creation returned no user");
  try {
    const domain = input.email.split("@")[1];
    const schoolEmail = env.SCHOOL_EMAIL_DOMAINS.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean).includes(domain);
    const { data: personId, error: linkError } = await admin.rpc("provision_student_login", {
      p_user_id: data.user.id, p_email: input.email, p_token_hash: hashSecret(token),
      p_purpose: purpose, p_full_name: input.full_name ?? null, p_student_number: input.student_number ?? null,
      p_school_email: schoolEmail,
    });
    if (linkError?.code === "TP061") throw ApiError.forbidden("An officer must approve activation for this unverified email");
    if (["TP060", "23505"].includes(linkError?.code ?? "")) throw ApiError.conflict("Account or student number already exists, or verification has expired");
    if (linkError) throw linkError;
    return { user_id: data.user.id, person_id: personId, role: "student" as const };
  } catch (error) {
    const { error: cleanupError } = await admin.auth.admin.deleteUser(data.user.id);
    if (cleanupError) throw new ApiError("internal_error", "Account setup failed; contact support before retrying", 500);
    throw error;
  }
}
