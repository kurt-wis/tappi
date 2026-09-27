import { handler, ok, readJson } from "@/lib/http";
import { requireAuth } from "@/lib/supabase/server";
import { deleteEvent, getEvent, updateEvent } from "@/lib/events";

type Context = { params: Promise<{ id: string }> };

export const GET = handler(async (_request: Request, route: Context) => {
  const ctx = await requireAuth();
  return ok(await getEvent(ctx, (await route.params).id));
});

export const PATCH = handler(async (request: Request, route: Context) => {
  const ctx = await requireAuth();
  return ok(await updateEvent(ctx, (await route.params).id, await readJson(request)));
});

export const DELETE = handler(async (_request: Request, route: Context) => {
  const ctx = await requireAuth();
  return ok(await deleteEvent(ctx, (await route.params).id));
});
