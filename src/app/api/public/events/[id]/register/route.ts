import { handler, ok, readJson, ApiError } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { z } from "zod";
import { createHash } from "crypto";
import { normalizeStudentNumber } from "@/lib/registration-form";

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

type MemberRow = { id: string };

type SessionRow = {
  verified: boolean;
  autofill_token_expires_at: string | null;
  student_number_normalized: string;
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

  const { data: event } = await admin
    .from("events")
    .select("id,org_id,status,slots,walk_in_policy")
    .eq("id", eventId)
    .returns<EventRow[]>()
    .maybeSingle();

  if (!event) throw ApiError.notFound("Event not found");
  if (event.status !== "published") throw ApiError.conflict("Event is not open for registration");

  if (event.slots !== null) {
    const { count } = await admin
      .from("registrations")
      .select("id", { count: "exact", head: true })
      .eq("event_id", eventId)
      .in("status", ["pending", "approved"]);
    if ((count ?? 0) >= event.slots) throw ApiError.conflict("Event is full");
  }

  let autofillUsed = false;
  if (body.autofillToken) {
    const tokenHash = createHash("sha256").update(body.autofillToken).digest("hex");
    const { data: session } = await admin
      .from("registration_lookup_sessions")
      .select("verified,autofill_token_expires_at,student_number_normalized")
      .eq("autofill_token_hash", tokenHash)
      .returns<SessionRow[]>()
      .maybeSingle();

    if (
      session?.verified &&
      session.student_number_normalized === normalized &&
      session.autofill_token_expires_at &&
      new Date(session.autofill_token_expires_at) > new Date()
    ) {
      autofillUsed = true;
      await admin
        .from("registration_lookup_sessions")
        .update({ autofill_token_hash: null, autofill_token_expires_at: null })
        .eq("autofill_token_hash", tokenHash);
    }
  }

  const { data: existing } = await admin
    .from("members")
    .select("id")
    .eq("org_id", event.org_id)
    .eq("student_number", normalized)
    .returns<MemberRow[]>()
    .maybeSingle();

  let memberId: string;
  if (existing) {
    memberId = existing.id;
  } else {
    const { data: created, error: cErr } = await admin
      .from("members")
      .insert({
        org_id: event.org_id,
        student_number: normalized,
        full_name: body.full_name,
        email: body.email,
        member_role: "attendee",
        status: "active",
      })
      .select("id")
      .returns<MemberRow[]>()
      .single();

    if (cErr) {
      if (cErr.code === "23505") {
        const { data: retry } = await admin
          .from("members")
          .select("id")
          .eq("org_id", event.org_id)
          .eq("student_number", normalized)
          .returns<MemberRow[]>()
          .maybeSingle();
        if (!retry) throw cErr;
        memberId = retry.id;
      } else {
        throw cErr;
      }
    } else {
      memberId = created!.id;
    }
  }

  const { data: reg, error: rErr } = await admin
    .from("registrations")
    .insert({
      event_id: eventId,
      org_id: event.org_id,
      member_id: memberId,
      full_name: body.full_name,
      student_number: normalized,
      email: body.email,
      answers: body.answers,
      autofill_used: autofillUsed,
      source: "public_form",
      status: "pending",
    })
    .select("id,status,created_at")
    .returns<RegistrationRow[]>()
    .single();

  if (rErr) {
    if (rErr.code === "23505") {
      throw ApiError.conflict("You are already registered for this event");
    }
    throw rErr;
  }

  return ok({ registration: reg, autofill_used: autofillUsed }, { status: 201 });
});