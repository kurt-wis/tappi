import { handler, ok } from "@/lib/http";
import { requireAuth } from "@/lib/supabase/server";
import { unlinkCard } from "@/lib/member-cards";

type Context = { params: Promise<{ id: string }> };

export const POST = handler(async (_request: Request, route: Context) => {
  const ctx = await requireAuth();
  return ok(await unlinkCard(ctx, (await route.params).id));
});
