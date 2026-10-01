import { handler, ok, readJson } from "@/lib/http";
import { signupOrganization, signupSchema } from "@/lib/auth/signup";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { provisionStudent, studentSignupSchema } from "@/lib/auth/student";

export const POST = handler(async (request: Request) => {
  const body = await readJson(request);
  if (body && typeof body === "object" && "mode" in body && body.mode === "student") {
    return ok(await provisionStudent(studentSignupSchema.parse(body), "signup"), { status: 201 });
  }
  const input = signupSchema.parse(body);
  const account = await signupOrganization(supabaseAdmin(), input);
  return ok(account, { status: 201 });
});
