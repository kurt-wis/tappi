import { z } from "zod";
import { handler, ok, readJson } from "@/lib/http";
import { emailSchema, studentNumberSchema, sendOtp } from "@/lib/auth/student";

const schema = z.object({
  email: emailSchema.optional(), student_number: studentNumberSchema.optional(),
  purpose: z.enum(["signup", "activation", "autofill"]),
}).strict().refine((v) => v.purpose === "signup" ? Boolean(v.email) : Boolean(v.email || v.student_number), "Provide email or student number");

export const POST = handler(async (request: Request) => ok(await sendOtp(schema.parse(await readJson(request)))));
