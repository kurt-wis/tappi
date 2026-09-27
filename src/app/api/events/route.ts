import { handler, ok, readJson } from "@/lib/http";
import { requireAuth } from "@/lib/supabase/server";
import { createEvent, listEvents } from "@/lib/events";

export const GET = handler(async (request: Request) => {
  const ctx = await requireAuth();
  return ok(await listEvents(ctx, Object.fromEntries(new URL(request.url).searchParams)));
});

export const POST = handler(async (request: Request) => {
  const ctx = await requireAuth();
  return ok(await createEvent(ctx, await readJson(request)), { status: 201 });
});
