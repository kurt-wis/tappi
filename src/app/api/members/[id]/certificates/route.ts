import { handler, ok } from "@/lib/http";
import { requireAuth } from "@/lib/supabase/server";
import { listMemberCertificates } from "@/lib/certificates";

type Context = { params: Promise<{ id: string }> };

export const GET = handler(async (_request: Request, route: Context) => {
  const ctx = await requireAuth();
  return ok(await listMemberCertificates(ctx, (await route.params).id));
});
