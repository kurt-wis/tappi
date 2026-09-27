import { handler, ok, readJson } from "@/lib/http";
import { requireAuth } from "@/lib/supabase/server";
import { linkCard } from "@/lib/member-cards";

type Context = { params: Promise<{ id: string }> };

export const POST = handler(async (request: Request, route: Context) => {
  const ctx = await requireAuth();
  return ok(await linkCard(ctx, (await route.params).id, await readJson(request)));
});
