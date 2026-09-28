import { handler, ok, readJson } from "@/lib/http";
import { requireAuth } from "@/lib/supabase/server";
import { adjustCredits, getMemberCredits } from "@/lib/credits";

type Context = { params: Promise<{ id: string }> };

export const GET = handler(async (request: Request, route: Context) => {
  const ctx = await requireAuth();
  return ok(await getMemberCredits(ctx, (await route.params).id, Object.fromEntries(new URL(request.url).searchParams)));
});

export const POST = handler(async (request: Request, route: Context) => {
  const ctx = await requireAuth();
  return ok(await adjustCredits(ctx, (await route.params).id, await readJson(request)), { status: 201 });
});
