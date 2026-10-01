import { handler, ok, readJson } from "@/lib/http";
import { signupOrganization, signupSchema } from "@/lib/auth/signup";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { provisionStudent, studentSignupSchema } from "@/lib/auth/student";
import { recordAudit } from "@/lib/audit";
import { clientIp, enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";

export const POST = handler(async (request: Request) => {
  await enforceRateLimit(RATE_LIMITS.signupIp, clientIp(request));
  const body = await readJson(request);
  if (body && typeof body === "object" && "mode" in body && body.mode === "student") {
    return ok(await provisionStudent(studentSignupSchema.parse(body), "signup"), { status: 201 });
  }
  const input = signupSchema.parse(body);
  const account = await signupOrganization(supabaseAdmin(), input);
  await recordAudit({ orgId: account.org_id, userId: account.user_id }, {
    action: "org.created", entity: "organizations", entity_id: account.org_id,
  });
  return ok(account, { status: 201 });
});
