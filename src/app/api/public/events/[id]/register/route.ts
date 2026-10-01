import { handler, ok, readJson, ApiError } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { z } from "zod";
import { createHash } from "crypto";
import { buildAnswersSchema, normalizeStudentNumber, type FormField } from "@/lib/registration-form";

const bodySchema = z.object({
  full_name: z.string().trim().min(1).max(200),
  student_number: z.string().trim().min(1).max(64),
  email: z.string().email().max(254),
  answers: z.record(z.unknown()).default({}),
  autofillToken: z.string().min(32).optional(),
}).strict();

type Context = { params: Promise<{ id: string }> };

type EventRow = {
  id: string;
  org_id: string;
  status: string;
  slots: number | null;
  walk_in_policy: string;
};

type SessionRow = {
  verified: boolean;
  autofill_token_expires_at: string | null;
  student_number_normalized: string;
  event_id: string;
  org_id: string;
};

type RegistrationRow = {
  id: string;
  status: string;
  created_at: string;
};

export const POST = handler(async (request: Request, route: Context) => {
  const { id: eventId } = await route.params;
  const body = bodySchema.parse(await readJson(request));
  const normalized = normalizeStudentNumber(body.student_number);
  const admin = supabaseAdmin();

  const { data: event, error: eventError } = await admin
    .from("events")
    .select("id,org_id,status,slots,walk_in_policy")
    .eq("id", eventId)
    .returns<EventRow[]>()
    .maybeSingle();

  if (eventError) throw eventError;
  if (!event) throw ApiError.notFound("Event not found");
  if (event.status !== "published") throw ApiError.conflict("Event is not open for registration");

  let autofillUsed = false;
  let consumedTokenHash: string | null = null;
  if (body.autofillToken) {
    const tokenHash = createHash("sha256").update(body.autofillToken).digest("hex");
    const { data: session, error: sessionError } = await admin
      .from("registration_lookup_sessions")
      .select("verified,autofill_token_expires_at,student_number_normalized,event_id,org_id")
      .eq("autofill_token_hash", tokenHash)
      .returns<SessionRow[]>()
      .maybeSingle();

    if (sessionError) throw sessionError;
    if (
      session?.verified &&
      session.student_number_normalized === normalized &&
      session.event_id === eventId &&
      session.org_id === event.org_id &&
      session.autofill_token_expires_at &&
      new Date(session.autofill_token_expires_at) > new Date()
    ) {
      autofillUsed = true;
      consumedTokenHash = tokenHash;
    } else {
      throw ApiError.conflict("Autofill verification expired or does not match this registration");
    }
  }

  const [{ data: orgFields, error: orgFieldsError }, { data: eventFields, error: eventFieldsError }] = await Promise.all([
    admin.from("org_form_fields").select("key,label,type,required,options,position")
      .eq("org_id", event.org_id).order("position"),
    admin.from("event_form_fields").select("key,label,type,required,options,position")
      .eq("event_id", eventId).order("position"),
  ]);
  if (orgFieldsError) throw orgFieldsError;
  if (eventFieldsError) throw eventFieldsError;
  const answers = buildAnswersSchema([
    ...((orgFields ?? []).map((field) => ({ ...field, source: "org_default" })) as FormField[]),
    ...((eventFields ?? []).map((field) => ({ ...field, source: "event_extra" })) as FormField[]),
  ]).parse(body.answers);

  const { data: reg, error: rErr } = await admin.rpc("register_for_event", {
    p_event_id: eventId,
    p_full_name: body.full_name,
    p_student_number: normalized,
    p_email: body.email,
    p_answers: answers,
    p_autofill_used: autofillUsed,
    p_autofill_token_hash: consumedTokenHash,
  });

  if (rErr) {
    if (rErr.code === "23505") {
      throw ApiError.conflict("You are already registered for this event");
    }
    if (rErr.code === "TP050") throw ApiError.notFound("Event not found");
    if (rErr.code === "TP051") throw ApiError.conflict("Event is not open for registration");
    if (rErr.code === "TP052") throw ApiError.conflict("Event is full");
    if (rErr.code === "TP055") throw ApiError.conflict("Autofill verification expired or already used");
    throw rErr;
  }

  return ok({ registration: reg, autofill_used: autofillUsed }, { status: 201 });
});
