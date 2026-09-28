import { handler, ok } from "@/lib/http";
import { verifyCertificate } from "@/lib/certificates";

type Context = { params: Promise<{ code: string }> };

// Public (see isPublicPath in middleware): anyone holding a certificate code can verify it.
export const GET = handler(async (_request: Request, route: Context) => {
  return ok(await verifyCertificate((await route.params).code));
});
