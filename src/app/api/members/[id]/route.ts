import { handler, ok, readJson } from "@/lib/http";
import { requireAuth } from "@/lib/supabase/server";
import { archiveMember, getMember, updateMember } from "@/lib/members";

type Context = { params: Promise<{ id: string }> };

export const GET = handler(async (_request: Request, route: Context) => {
  const ctx = await requireAuth();
  return ok(await getMember(ctx, (await route.params).id));
});

export const PATCH = handler(async (request: Request, route: Context) => {
  const ctx = await requireAuth();
  return ok(await updateMember(ctx, (await route.params).id, await readJson(request)));
});

export const DELETE = handler(async (_request: Request, route: Context) => {
  const ctx = await requireAuth();
  return ok(await archiveMember(ctx, (await route.params).id));
});
