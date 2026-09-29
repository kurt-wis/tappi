import { handler, ok } from "@/lib/http";
import { requireAuth } from "@/lib/supabase/server";
import { reconcileEvent } from "@/lib/finalize";

type Context = { params: Promise<{ id: string }> };

export const POST = handler(async (_request: Request, route: Context) => {
  const ctx = await requireAuth();
  const { id } = await route.params;
  return ok(await reconcileEvent(ctx, id));
});
