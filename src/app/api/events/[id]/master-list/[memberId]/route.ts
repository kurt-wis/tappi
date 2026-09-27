import { handler, ok } from "@/lib/http";
import { requireAuth } from "@/lib/supabase/server";
import { removeFromMasterList } from "@/lib/events";

type Context = { params: Promise<{ id: string; memberId: string }> };

export const DELETE = handler(async (_request: Request, route: Context) => {
  const ctx = await requireAuth();
  const { id, memberId } = await route.params;
  return ok(await removeFromMasterList(ctx, id, memberId));
});
