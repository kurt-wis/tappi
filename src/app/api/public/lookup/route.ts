import { handler, ok, readJson, ApiError } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { env } from "@/lib/env";
import { z } from "zod";
import { createHash } from "crypto";
import { Resend } from "resend";

const bodySchema = z.object({
  studentNumber: z.string().min(1).max(64),
  eventId: z.string().uuid(),
});

function normalizeStudentNumber(s: string): string {
  return s.replace(/[-\s]/g, "").trim();
}

function maskName(name: string): string {
  const first = (name || "").split(" ")[0] || "";
  if (first.length <= 1) return first;
  return first[0] + "***";
}

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "***";
  return `${local.slice(0, 1)}***@${domain}`;
}

function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

export const POST = handler(async (req: Request) => {
  const { studentNumber, eventId } = bodySchema.parse(await readJson(req));
  const normalized = normalizeStudentNumber(studentNumber);
  const admin = supabaseAdmin();

  const { data: event } = await admin
    .from("events")
    .select("id, org_id")
    .eq("id", eventId)
    .maybeSingle();

  if (!event) return ok({ found: false });

  const { data: member } = await admin
    .from("members")
    .select("id, full_name, email")
    .eq("org_id", event.org_id)
    .eq("student_number", normalized)
    .maybeSingle();

  if (!member || !member.email) return ok({ found: false });

  const otp = String(Math.floor(100000 + Math.random() * 900000));
  const otpHash = hashCode(otp);

  const { data: session, error: sErr } = await admin
    .from("registration_lookup_sessions")
    .insert({
      student_number_normalized: normalized,
      masked_first_name: maskName(member.full_name),
      masked_email: maskEmail(member.email),
      otp_code_hash: otpHash,
      otp_expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    })
    .select("id")
    .single();

  if (sErr || !session) {
    throw new ApiError("internal_error", "Could not start lookup session", 500);
  }

  if (env.RESEND_API_KEY) {
    const resend = new Resend(env.RESEND_API_KEY);
    await resend.emails.send({
      from: env.EMAIL_FROM ?? "Tappi <onboarding@resend.dev>",
      to: member.email,
      subject: "Your Tappi verification code",
      html: `<p>Your verification code is <strong>${otp}</strong>. It expires in 10 minutes.</p>`,
    });
  } else {
    console.warn("[public/lookup] RESEND_API_KEY missing. Dev OTP:", otp);
  }

  return ok({
    found: true,
    sessionId: session.id,
    maskedFirstName: maskName(member.full_name),
    maskedEmail: maskEmail(member.email),
  });
});