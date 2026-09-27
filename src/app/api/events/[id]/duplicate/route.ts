import { handler, ok } from "@/lib/http";
import { requireAuth } from "@/lib/supabase/server";
import { duplicateEvent } from "@/lib/events";

type Context = { params: Promise<{ id: string }> };

export const POST = handler(async (_request: Request, route: Context) => {
  const ctx = await requireAuth();
  return ok(await duplicateEvent(ctx, (await route.params).id), { status: 201 });
});
