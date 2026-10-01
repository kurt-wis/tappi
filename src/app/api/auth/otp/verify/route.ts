import { z } from "zod";
import { handler, ok, readJson } from "@/lib/http";
import { emailSchema, verifyOtp } from "@/lib/auth/student";

const schema = z.object({ email: emailSchema, otp: z.string().regex(/^\d{6}$/), purpose: z.enum(["signup", "activation", "autofill"]) }).strict();
export const POST = handler(async (request: Request) => {
  const input = schema.parse(await readJson(request));
  return ok(await verifyOtp(input.email, input.otp, input.purpose));
});
