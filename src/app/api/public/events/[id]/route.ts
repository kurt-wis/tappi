import { handler, ok, ApiError } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { resolveFormSchema, type FormField } from "@/lib/registration-form";

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
};

type EventField = {
  key: string;
  label: string;
  type: string;
  required: boolean;
  options: unknown;
  position: number;
};

export const GET = handler(async (_request: Request, route: Context) => {
  const { id } = await route.params;
  const admin = supabaseAdmin();

  const { data: event } = await admin
    .from("events")
    .select(
      "id,org_id,title,description,venue,starts_at,ends_at,grace_period_minutes,slots," +
      "walk_in_policy,status,certificate_enabled,points_value",
    )
    .eq("id", id)
    .returns<PublicEvent[]>()
    .maybeSingle();

  if (!event) throw ApiError.notFound("Event not found");
  if (event.status !== "published" && event.status !== "completed") {
    throw ApiError.notFound("Event not found");
  }

  const { count: regCount } = await admin
    .from("registrations")
    .select("id", { count: "exact", head: true })
    .eq("event_id", id)
    .in("status", ["pending", "approved"]);

  const [{ data: orgDefaults }, { data: eventExtras }] = await Promise.all([
    admin.from("org_form_fields").select("key,label,type,required,options,position")
      .eq("org_id", event.org_id).order("position").returns<EventField[]>(),
    admin.from("event_form_fields").select("key,label,type,required,options,position")
      .eq("event_id", id).order("position").returns<EventField[]>(),
  ]);

  const taken = regCount ?? 0;
  const { org_id: _orgId, ...publicEvent } = event;
  return ok({
    ...publicEvent,
    registrations_count: taken,
    slots_remaining: event.slots !== null ? Math.max(0, event.slots - taken) : null,
    form_fields: resolveFormSchema(
      (orgDefaults ?? []).map((field) => ({ ...field, source: "org_default" })) as FormField[],
      (eventExtras ?? []).map((field) => ({ ...field, source: "event_extra" })) as FormField[],
    ),
  });
});
