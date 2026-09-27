import { handler, ok } from "@/lib/http";
import { requireAuth } from "@/lib/supabase/server";
import { getCardHistory } from "@/lib/member-cards";

type Context = { params: Promise<{ id: string }> };

export const GET = handler(async (_request: Request, route: Context) => {
  const ctx = await requireAuth();
  return ok(await getCardHistory(ctx, (await route.params).id));
});
