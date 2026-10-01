import { handler, ok, ApiError } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase/admin";

type Context = { params: Promise<{ eventId: string }> };

export const GET = handler(async (_request: Request, route: Context) => {
  const { eventId } = await route.params;
  const admin = supabaseAdmin();

  const { data: event, error: eventError } = await admin
    .from("events")
    .select("id,slots,status")
    .eq("id", eventId)
    .maybeSingle();
  if (eventError) throw eventError;
  if (!event || !["published", "completed"].includes(event.status)) throw ApiError.notFound("Event not found");

  const { count, error: countError } = await admin
    .from("registrations")
    .select("id", { count: "exact", head: true })
    .eq("event_id", eventId)
    .in("status", ["pending", "approved"]);

  if (countError) throw countError;
  const taken = count ?? 0;
  return ok({
    slots: event.slots,
    taken,
    remaining: event.slots !== null ? Math.max(0, event.slots - taken) : null,
    open: event.status === "published",
  });
});
