import { handler, ok, readJson } from "@/lib/http";
import { requireAuth } from "@/lib/supabase/server";
import { reviewRegistration } from "@/lib/registrations";

type Context = { params: Promise<{ id: string }> };

export const PATCH = handler(async (request: Request, route: Context) => {
  const ctx = await requireAuth();
  const { id } = await route.params;
  return ok(await reviewRegistration(ctx, id, await readJson(request)));
});