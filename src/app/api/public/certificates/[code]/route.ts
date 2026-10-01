import { handler, ok } from "@/lib/http";
import { verifyCertificate } from "@/lib/certificates";
import { clientIp, enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";

type Context = { params: Promise<{ code: string }> };

export const GET = handler(async (request: Request, route: Context) => {
  await enforceRateLimit(RATE_LIMITS.certificateVerifyIp, clientIp(request));
  return ok(await verifyCertificate((await route.params).code));
});
