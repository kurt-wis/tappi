import { z } from "zod";
import { handler, ok, readJson } from "@/lib/http";
import { emailSchema, verifyOtp } from "@/lib/auth/student";
import { clientIp, enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";

const schema = z.object({ email: emailSchema, otp: z.string().regex(/^\d{6}$/), purpose: z.enum(["signup", "activation", "autofill"]) }).strict();
export const POST = handler(async (request: Request) => {
  await enforceRateLimit(RATE_LIMITS.otpVerifyIp, clientIp(request));
  const input = schema.parse(await readJson(request));
  return ok(await verifyOtp(input.email, input.otp, input.purpose));
});
