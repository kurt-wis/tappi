import { handler, ok } from "@/lib/http";
import { requireAuth } from "@/lib/supabase/server";
import { cancelEvent } from "@/lib/events";

type Context = { params: Promise<{ id: string }> };

export const POST = handler(async (_request: Request, route: Context) => {
  const ctx = await requireAuth();
  return ok(await cancelEvent(ctx, (await route.params).id));
});
