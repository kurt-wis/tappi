import { handler, ok, ApiError } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase/admin";

type Context = { params: Promise<{ eventId: string }> };

export const GET = handler(async (_request: Request, route: Context) => {
  const { eventId } = await route.params;
  const admin = supabaseAdmin();

  const { data: event } = await admin
    .from("events")
    .select("id,slots,status")
    .eq("id", eventId)
    .maybeSingle();
  if (!event) throw ApiError.notFound("Event not found");

  const { count } = await admin
    .from("registrations")
    .select("id", { count: "exact", head: true })
    .eq("event_id", eventId)
    .in("status", ["pending", "approved"]);

  const taken = count ?? 0;
  return ok({
    slots: event.slots,
    taken,
    remaining: event.slots !== null ? Math.max(0, event.slots - taken) : null,
    open: event.status === "published",
  });
});