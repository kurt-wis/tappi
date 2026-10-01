import { handler, ok, readOptionalJson } from "@/lib/http";
import { requireAuth } from "@/lib/supabase/server";
import { revokeCertificate } from "@/lib/certificates";

type Context = { params: Promise<{ id: string }> };

export const POST = handler(async (request: Request, route: Context) => {
  const ctx = await requireAuth();
  return ok(await revokeCertificate(ctx, (await route.params).id, await readOptionalJson(request)));
});
