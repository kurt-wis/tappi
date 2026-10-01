import { z } from "zod";
import { handler, ok, ApiError } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { resolveEventForm } from "@/lib/event-forms";

type Context = { params: Promise<{ id: string }> };

type PublicEvent = {
  id: string;
  org_id: string;
  title: string;
  description: string | null;
  venue: string | null;
  starts_at: string;
  ends_at: string | null;
  grace_period_minutes: number;
  slots: number | null;
  walk_in_policy: string;
  status: string;
  certificate_enabled: boolean;
  points_value: number;
  form_fields: unknown;
};

export const GET = handler(async (_request: Request, route: Context) => {
  const { id } = await route.params;
  if (!z.string().uuid().safeParse(id).success) throw ApiError.notFound("Event not found");
  const admin = supabaseAdmin();

  const { data: event, error: eventError } = await admin
    .from("events")
    .select(
      "id,org_id,title,description,venue,starts_at,ends_at,grace_period_minutes,slots," +
      "walk_in_policy,status,certificate_enabled,points_value,form_fields",
    )
    .eq("id", id)
    .returns<PublicEvent[]>()
    .maybeSingle();

  if (eventError) throw eventError;
  if (!event) throw ApiError.notFound("Event not found");
  if (event.status !== "published" && event.status !== "completed") {
    throw ApiError.notFound("Event not found");
  }

  const { count: regCount, error: countError } = await admin
    .from("registrations")
    .select("id", { count: "exact", head: true })
    .eq("event_id", id)
    .in("status", ["pending", "approved"]);

  if (countError) throw countError;
  const { fields } = await resolveEventForm(event.org_id, event.form_fields);

  const taken = regCount ?? 0;
  const { org_id: _orgId, form_fields: _storedFields, ...publicEvent } = event;
  return ok({
    ...publicEvent,
    registrations_count: taken,
    slots_remaining: event.slots !== null ? Math.max(0, event.slots - taken) : null,
    form_fields: fields,
  });
});
