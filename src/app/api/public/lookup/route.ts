import { z } from "zod";
import { randomInt } from "node:crypto";
import { handler, ok, readJson, ApiError } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { studentNumberSchema, hashSecret, sendVerificationEmail } from "@/lib/auth/student";

const schema = z.object({ studentNumber: studentNumberSchema, eventId: z.string().uuid() }).strict();

export const POST = handler(async (request: Request) => {
  const { studentNumber, eventId } = schema.parse(await readJson(request));
  const admin = supabaseAdmin();
  const { data: event, error: eventError } = await admin.from("events").select("id,org_id")
    .eq("id", eventId).eq("status", "published").maybeSingle();
  if (eventError) throw eventError;
  if (!event) return ok({ found: false });
  const { data: member, error: memberError } = await admin.from("members")
    .select("person_id,full_name,email").eq("org_id", event.org_id).eq("student_number", studentNumber).maybeSingle();
  if (memberError) throw memberError;
  if (!member?.email) return ok({ found: false });
  const { data: person, error: personError } = await admin.from("persons")
    .select("email,full_name").eq("id", member.person_id).is("merged_into", null).maybeSingle();
  if (personError) throw personError;
  if (!person?.email) return ok({ found: false });
  const maskedFirstName = person.full_name.trim().slice(0, 1) + "***";
  const maskedEmail = String(person.email).replace(/^(.).*(@.*)$/, "$1***$2");
  const code = String(randomInt(100000, 1000000));
  const { data: sessionId, error } = await admin.rpc("start_registration_lookup", {
    p_event_id: eventId, p_person_id: member.person_id, p_number: studentNumber,
    p_masked_name: maskedFirstName, p_masked_email: maskedEmail, p_code_hash: hashSecret(code),
  });
  if (error) throw error;
  if (!sessionId) throw new ApiError("rate_limited", "Wait a minute before requesting another code", 429);
  try { await sendVerificationEmail(person.email, code); }
  catch (error) {
    await admin.from("registration_lookup_sessions").delete().eq("id", sessionId);
    throw error;
  }
  return ok({ found: true, sessionId, maskedFirstName, maskedEmail });
});
