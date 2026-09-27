import { handler, ok, readJson } from "@/lib/http";
import { requireAuth } from "@/lib/supabase/server";
import { addToMasterList, listMasterList } from "@/lib/events";

type Context = { params: Promise<{ id: string }> };

export const GET = handler(async (_request: Request, route: Context) => {
  const ctx = await requireAuth();
  return ok(await listMasterList(ctx, (await route.params).id));
});

export const POST = handler(async (request: Request, route: Context) => {
  const ctx = await requireAuth();
  return ok(await addToMasterList(ctx, (await route.params).id, await readJson(request)));
});
