import { z } from "zod";
import { ApiError } from "@/lib/http";
import { requireRole, type AuthContext } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

const uuid = z.string().uuid();

export const approveSchema = z.object({
  action: z.enum(["approve", "deny"]),
}).strict();

export const registrationsQuerySchema = z.object({
  event_id: uuid.optional(),
  status: z.enum(["pending", "approved", "denied"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(200).default(50),
}).strict();

type PgError = { code?: string; message: string };

type RegistrationRow = {
  id: string;
  event_id: string;
  org_id: string;
  member_id: string | null;
  full_name: string;
  student_number: string;
  email: string | null;
  status: "pending" | "approved" | "denied";
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
  autofill_used: boolean;
  source: string;
};

export async function listRegistrations(ctx: AuthContext, input: unknown) {
  const { event_id, status, page, per_page } = registrationsQuerySchema.parse(input);

  let query = ctx.supabase
    .from("registrations")
    .select("*", { count: "exact" })
    .eq("org_id", ctx.orgId);

  if (event_id) query = query.eq("event_id", event_id);
  if (status) query = query.eq("status", status);

  const { data, error, count } = await query
    .order("created_at", { ascending: false })
    .range((page - 1) * per_page, page * per_page - 1)
    .returns<RegistrationRow[]>();

  if (error) throw error;

  return {
    registrations: data ?? [],
    pagination: {
      page,
      per_page,
      total: count ?? 0,
      total_pages: Math.ceil((count ?? 0) / per_page),
    },
  };
}

export async function reviewRegistration(
  ctx: AuthContext,
  registrationId: string,
  input: unknown,
) {
  requireRole(ctx, ["officer"]);
  uuid.parse(registrationId);
  const { action } = approveSchema.parse(input);

  const admin = supabaseAdmin();

  const { data: reg } = await admin
    .from("registrations")
    .select("id,event_id,org_id,member_id,student_number,status")
    .eq("id", registrationId)
    .eq("org_id", ctx.orgId)
    .returns<RegistrationRow[]>()
    .maybeSingle();

  if (!reg) throw ApiError.notFound("Registration not found");
  if (reg.status !== "pending") {
    throw ApiError.conflict("This registration has already been reviewed");
  }

  const newStatus = action === "approve" ? "approved" : "denied";

  const { data: updated, error: uErr } = await admin
    .from("registrations")
    .update({
      status: newStatus,
      reviewed_by: ctx.userId,
      reviewed_at: new Date().toISOString(),
    })
    .eq("id", registrationId)
    .select("*")
    .returns<RegistrationRow[]>()
    .single();

  if (uErr) throw uErr;

  // Per PDF: on approval of a non-directory person, the system
  // automatically creates a lightweight directory entry using the
  // details they provided. If a member already exists for this
  // (org, student_number), link to it instead.
  if (action === "approve" && !reg.member_id) {
    const { data: existingMember } = await admin
      .from("members")
      .select("id")
      .eq("org_id", ctx.orgId)
      .eq("student_number", reg.student_number)
      .returns<{ id: string }[]>()
      .maybeSingle();

    let memberId = existingMember?.id;

    if (!memberId) {
      const { data: reg2 } = await admin
        .from("registrations")
        .select("full_name,email,student_number")
        .eq("id", registrationId)
        .returns<{ full_name: string; email: string | null; student_number: string }[]>()
        .single();

      if (reg2) {
        const { data: created, error: cErr } = await admin
          .from("members")
          .insert({
            org_id: ctx.orgId,
            student_number: reg2.student_number,
            full_name: reg2.full_name,
            email: reg2.email,
            member_role: "attendee",
            status: "active",
          })
          .select("id")
          .returns<{ id: string }[]>()
          .single();
        if (cErr) throw cErr;
        memberId = created?.id;
      }
    }

    if (memberId) {
      await admin
        .from("registrations")
        .update({ member_id: memberId })
        .eq("id", registrationId);
    }
  }

  return updated;
}