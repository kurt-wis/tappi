import { handler, ok } from "@/lib/http";
import { requireAuth } from "@/lib/supabase/server";
import { listRegistrations } from "@/lib/registrations";

export const GET = handler(async (request: Request) => {
  const ctx = await requireAuth();
  return ok(await listRegistrations(ctx, Object.fromEntries(new URL(request.url).searchParams)));
});