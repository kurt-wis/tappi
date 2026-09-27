import { handler, ok, readJson } from "@/lib/http";
import { signupOrganization, signupSchema } from "@/lib/auth/signup";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const POST = handler(async (request: Request) => {
  const input = signupSchema.parse(await readJson(request));
  const account = await signupOrganization(supabaseAdmin(), input);
  return ok(account, { status: 201 });
});
