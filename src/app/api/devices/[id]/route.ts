import { handler, ok, readJson } from "@/lib/http";
import { requireAuth } from "@/lib/supabase/server";
import { deleteDevice, getDevice, updateDevice } from "@/lib/devices";

type Context = { params: Promise<{ id: string }> };

export const GET = handler(async (_request: Request, route: Context) => {
  const ctx = await requireAuth();
  return ok(await getDevice(ctx, (await route.params).id));
});

export const PATCH = handler(async (request: Request, route: Context) => {
  const ctx = await requireAuth();
  return ok(await updateDevice(ctx, (await route.params).id, await readJson(request)));
});

export const DELETE = handler(async (_request: Request, route: Context) => {
  const ctx = await requireAuth();
  return ok(await deleteDevice(ctx, (await route.params).id));
});
