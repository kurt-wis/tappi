import { handler, ok, readJson, ApiError } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { z } from "zod";
import { createHash } from "crypto";

const bodySchema = z.object({
  autofillToken: z.string().min(32),
  eventId: z.string().uuid(),
});

function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

export const POST = handler(async (req: Request) => {
  const { autofillToken, eventId } = bodySchema.parse(await readJson(req));
  const admin = supabaseAdmin();

  const { data: session, error: sessionError } = await admin
    .from("registration_lookup_sessions")
    .select("*")
    .eq("autofill_token_hash", hashCode(autofillToken))
    .eq("verified", true)
    .eq("event_id", eventId)
    .maybeSingle();

  if (sessionError) throw sessionError;
  if (!session) throw ApiError.notFound("Invalid token");
  if (!session.autofill_token_expires_at || new Date(session.autofill_token_expires_at) < new Date())
    throw ApiError.conflict("Token expired");

  const { data: event, error: eventError } = await admin
    .from("events")
    .select("id, org_id")
    .eq("id", eventId)
    .maybeSingle();
  if (eventError) throw eventError;
  if (!event) throw ApiError.notFound("Event not found");
  if (session.org_id !== event.org_id) throw ApiError.notFound("Invalid token");

  const { data: member, error: memberError } = await admin
    .from("members")
    .select("id, full_name, email, student_number, course")
    .eq("org_id", event.org_id)
    .eq("person_id", session.person_id)
    .maybeSingle();
  if (memberError) throw memberError;
  if (!member) throw ApiError.notFound("Member not found");

  const [{ data: orgDefaults, error: orgError }, { data: eventExtras, error: fieldsError }] = await Promise.all([
    admin.from("org_form_fields").select("*").eq("org_id", event.org_id).order("position"),
    admin.from("event_form_fields").select("*").eq("event_id", eventId).order("position"),
  ]);
  if (orgError) throw orgError;
  if (fieldsError) throw fieldsError;

  return ok({
    member: {
      full_name: member.full_name,
      email: member.email,
      student_number: member.student_number,
      course: member.course,
    },
    orgDefaults: orgDefaults ?? [],
    eventExtras: eventExtras ?? [],
  });
});
