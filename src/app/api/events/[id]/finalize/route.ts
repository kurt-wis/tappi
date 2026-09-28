import { handler, ok, readJson } from "@/lib/http";
import { requireAuth } from "@/lib/supabase/server";
import { finalizeEvent } from "@/lib/finalize";

type Context = { params: Promise<{ id: string }> };

export const POST = handler(async (request: Request, route: Context) => {
  const ctx = await requireAuth();

  let force = false;
  try {
    const body = (await readJson(request)) as { force?: boolean };
    force = Boolean(body?.force);
  } catch {
    // no body is fine — default to force: false
  }

  return ok(await finalizeEvent(ctx, (await route.params).id, { force }));
});