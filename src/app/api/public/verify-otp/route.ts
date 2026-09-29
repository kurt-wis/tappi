import { handler, ok, readJson, ApiError } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { z } from "zod";
import { randomBytes, createHash } from "crypto";

const bodySchema = z.object({
  sessionId: z.string().uuid(),
  otp: z.string().length(6),
});

function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

export const POST = handler(async (req: Request) => {
  const { sessionId, otp } = bodySchema.parse(await readJson(req));
  const admin = supabaseAdmin();

  const { data: session } = await admin
    .from("registration_lookup_sessions")
    .select("*")
    .eq("id", sessionId)
    .maybeSingle();

  if (!session) throw ApiError.notFound("Lookup session not found");
  if (new Date(session.expires_at) < new Date())
    throw ApiError.conflict("Lookup session expired");
  if (session.otp_attempts >= 3) throw ApiError.conflict("Too many attempts");
  if (!session.otp_expires_at || new Date(session.otp_expires_at) < new Date())
    throw ApiError.conflict("Code expired");

  if (hashCode(otp) !== session.otp_code_hash) {
    await admin
      .from("registration_lookup_sessions")
      .update({ otp_attempts: session.otp_attempts + 1 })
      .eq("id", sessionId);
    throw ApiError.conflict("Invalid code");
  }

  const token = randomBytes(32).toString("hex");
  const tokenHash = hashCode(token);

  await admin
    .from("registration_lookup_sessions")
    .update({
      verified: true,
      autofill_token_hash: tokenHash,
      autofill_token_expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    })
    .eq("id", sessionId);

  return ok({ autofillToken: token });
});