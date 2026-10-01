import { z } from "zod";
import { handler, ok, readJson } from "@/lib/http";
import { emailSchema, studentNumberSchema, provisionStudent } from "@/lib/auth/student";

const schema = z.object({
  email: emailSchema, password: z.string().min(8).max(128),
  student_number: studentNumberSchema.optional(), otp: z.string().regex(/^\d{6}$/).optional(),
  verificationToken: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
export const POST = handler(async (request: Request) => {
  const account = await provisionStudent(schema.parse(await readJson(request)), "activation");
  return ok({ activated: true, ...account }, { status: 201 });
});
