import { handler, ok, readJson } from "@/lib/http";
import { requireAuth } from "@/lib/supabase/server";
import { getEventForm, setEventFormFields } from "@/lib/event-forms";

type Context = { params: Promise<{ id: string }> };

export const GET = handler(async (_request: Request, route: Context) => {
  const ctx = await requireAuth();
  return ok(await getEventForm(ctx, (await route.params).id));
});

export const PUT = handler(async (request: Request, route: Context) => {
  const ctx = await requireAuth();
  return ok(await setEventFormFields(ctx, (await route.params).id, await readJson(request)));
});
