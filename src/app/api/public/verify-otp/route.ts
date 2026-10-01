import { z } from "zod";
import { randomBytes } from "node:crypto";
import { handler, ok, readJson, ApiError } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { hashSecret } from "@/lib/auth/student";

const schema = z.object({ sessionId: z.string().uuid(), otp: z.string().regex(/^\d{6}$/) }).strict();
export const POST = handler(async (request: Request) => {
  const { sessionId, otp } = schema.parse(await readJson(request));
  const token = randomBytes(32).toString("hex");
  const { data, error } = await supabaseAdmin().rpc("verify_registration_lookup", {
    p_session_id: sessionId, p_code_hash: hashSecret(otp), p_token_hash: hashSecret(token),
  });
  if (error) throw error;
  if (!data) throw ApiError.conflict("Invalid, expired, or exhausted verification code");
  return ok({ autofillToken: token });
});
