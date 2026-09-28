import { handler, ok } from "@/lib/http";
import { requireAuth } from "@/lib/supabase/server";
import { getMemberSummary } from "@/lib/reports";

type Context = { params: Promise<{ id: string }> };

export const GET = handler(async (_request: Request, route: Context) => {
  const ctx = await requireAuth();
  return ok(await getMemberSummary(ctx, (await route.params).id));
});
